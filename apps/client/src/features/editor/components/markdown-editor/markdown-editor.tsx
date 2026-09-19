import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Textarea } from "@mantine/core";
import { Editor, generateJSON, type JSONContent } from "@tiptap/core";
import { Fragment, Node as ProsemirrorNode, Slice } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { htmlToMarkdown, markdownToHtml } from "@docmost/editor-ext";
import { mainExtensions } from "@/features/editor/extensions/extensions";

// Tags transactions that originate from this markdown editor so the inbound
// reconcile loop can skip its own echoes (and avoid feedback loops).
const MARKDOWN_SYNC_META = "markdownEditorSync";

const SYNC_DEBOUNCE_MS = 300;

function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLen(a: string, b: string, prefixLen: number): number {
  const max = Math.min(a.length, b.length) - prefixLen;
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

// True if the block has only text children (no inline atoms like images).
function isPlainTextBlock(block: ProsemirrorNode): boolean {
  let ok = true;
  block.forEach((child) => {
    if (child.type.name !== "text") ok = false;
  });
  return ok;
}

// Signature of the block's mark topology — two blocks with the same pattern
// differ only in text, so a character-level diff is safe.
function markRunPattern(block: ProsemirrorNode): string {
  const runs: string[] = [];
  block.forEach((child) => {
    if (child.type.name === "text") {
      const sig = (child.marks ?? [])
        .map(
          (m) =>
            m.type.name +
            (m.attrs && Object.keys(m.attrs).length
              ? JSON.stringify(m.attrs)
              : ""),
        )
        .sort()
        .join("+");
      if (runs.length === 0 || runs[runs.length - 1] !== sig) runs.push(sig);
    } else {
      runs.push("__node__");
    }
  });
  return runs.join("|");
}

/**
 * Apply the markdown-derived document to the live editor as the smallest
 * possible ProseMirror transaction, then dispatch it tagged as a markdown
 * sync.
 *
 * The diff is always computed against the *current* editor state (which may
 * already contain concurrent remote edits), so unchanged blocks are never
 * touched. When a single block changed and only its text content differs, we
 * emit a targeted `insertText` over the exact character range — this maps to a
 * fine-grained Yjs text op, identical in shape to what a keystroke in the rich
 * editor produces, so the CRDT merges it cleanly with concurrent edits in other
 * blocks. Structural changes fall back to a scoped block replacement.
 */
function syncMarkdownToEditor(editor: Editor, newDocJson: JSONContent): void {
  const { state } = editor;
  const oldDoc = state.doc;
  const newDoc = state.schema.nodeFromJSON(newDocJson);

  if (oldDoc.eq(newDoc)) return;

  // Block-level prefix/suffix diff.
  let prefix = 0;
  const minLen = Math.min(oldDoc.childCount, newDoc.childCount);
  while (
    prefix < minLen &&
    oldDoc.child(prefix).eq(newDoc.child(prefix))
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldDoc.childCount - prefix &&
    suffix < newDoc.childCount - prefix &&
    oldDoc
      .child(oldDoc.childCount - 1 - suffix)
      .eq(newDoc.child(newDoc.childCount - 1 - suffix))
  ) {
    suffix++;
  }

  // Document position where the changed block range starts/ends in the old doc.
  let fromPos = 0;
  for (let i = 0; i < prefix; i++) fromPos += oldDoc.child(i).nodeSize;
  let toPos = oldDoc.content.size;
  for (let i = 0; i < suffix; i++)
    toPos -= oldDoc.child(oldDoc.childCount - 1 - i).nodeSize;

  const oldChangedCount = oldDoc.childCount - prefix - suffix;
  const newChangedCount = newDoc.childCount - prefix - suffix;

  // Single block, text-only change → character-level targeted edit.
  if (oldChangedCount === 1 && newChangedCount === 1) {
    const oldBlock = oldDoc.child(prefix);
    const newBlock = newDoc.child(prefix);

    if (
      oldBlock.type === newBlock.type &&
      JSON.stringify(oldBlock.attrs) === JSON.stringify(newBlock.attrs) &&
      isPlainTextBlock(oldBlock) &&
      isPlainTextBlock(newBlock) &&
      markRunPattern(oldBlock) === markRunPattern(newBlock)
    ) {
      const oldText = oldBlock.textContent;
      const newText = newBlock.textContent;

      if (oldText !== newText) {
        const tPrefix = commonPrefixLen(oldText, newText);
        const tSuffix = commonSuffixLen(oldText, newText, tPrefix);
        // +1 skips the block's opening token in ProseMirror's position model.
        const from = fromPos + 1 + tPrefix;
        const to = fromPos + 1 + oldText.length - tSuffix;
        const insert = newText.slice(tPrefix, newText.length - tSuffix);

        const tr = state.tr.insertText(insert, from, to);
        tr.setMeta(MARKDOWN_SYNC_META, true);
        tr.setMeta("addToHistory", false);
        editor.view.dispatch(tr);
        return;
      }
      // Text identical, only marks/attrs differ → fall through to replace.
    }
  }

  // Fallback: replace just the changed block range.
  const nodes: ProsemirrorNode[] = [];
  for (let i = prefix; i < newDoc.childCount - suffix; i++)
    nodes.push(newDoc.child(i));

  const tr = state.tr.replace(
    fromPos,
    toPos,
    new Slice(Fragment.from(nodes), 0, 0),
  );
  tr.setMeta(MARKDOWN_SYNC_META, true);
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
}

interface MarkdownEditorProps {
  editor: Editor | null;
  editable: boolean;
}

export function MarkdownEditor({ editor, editable }: MarkdownEditorProps) {
  const [markdown, setMarkdown] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Latest values, read inside event handlers / cleanup to dodge stale closures.
  const markdownRef = useRef("");
  const editorRef = useRef(editor);
  const editableRef = useRef(editable);
  const dirtyRef = useRef(false); // unflushed local edits pending
  const syncTimerRef = useRef<number | null>(null);
  const pendingCaretRef = useRef<number | null>(null);

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);
  useEffect(() => {
    editableRef.current = editable;
  }, [editable]);

  // Push the current markdown into the editor as a fine-grained transaction.
  const doSync = (md: string) => {
    const ed = editorRef.current;
    if (!ed || !editableRef.current) return;
    const html = markdownToHtml(md) as string;
    const json = generateJSON(html, mainExtensions);
    syncMarkdownToEditor(ed, json);
    dirtyRef.current = false;
  };

  const flushNow = () => {
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    if (dirtyRef.current) doSync(markdownRef.current);
  };

  const scheduleSync = (md: string) => {
    dirtyRef.current = true;
    if (syncTimerRef.current !== null)
      window.clearTimeout(syncTimerRef.current);
    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = null;
      doSync(md);
    }, SYNC_DEBOUNCE_MS);
  };

  // Pull the editor's current content into the textarea, preserving the caret.
  // Called when the document changed from anything other than our own sync
  // (i.e. remote collaborators or the rich editor).
  const reconcileFromEditor = () => {
    const ed = editorRef.current;
    if (!ed) return;

    // Make sure any unflushed local edit lands in the doc first, so Yjs merges
    // it with the incoming change instead of us overwriting one with the other.
    if (dirtyRef.current) flushNow();

    const md = htmlToMarkdown(ed.getHTML());
    const prev = markdownRef.current;
    if (md === prev) return;

    // Rebase the caret across the change in markdown space.
    const ta = textareaRef.current;
    const caret = ta ? ta.selectionStart : md.length;
    const p = commonPrefixLen(prev, md);
    const s = commonSuffixLen(prev, md, p);
    let nextCaret: number;
    if (caret <= p) nextCaret = caret;
    else if (caret >= prev.length - s) nextCaret = caret + (md.length - prev.length);
    else nextCaret = md.length - s;
    pendingCaretRef.current = Math.max(0, Math.min(nextCaret, md.length));

    markdownRef.current = md;
    setMarkdown(md);
  };

  // Restore the caret after a programmatic textarea update.
  useLayoutEffect(() => {
    if (pendingCaretRef.current === null) return;
    const ta = textareaRef.current;
    const caret = pendingCaretRef.current;
    pendingCaretRef.current = null;
    if (ta) ta.setSelectionRange(caret, caret);
  }, [markdown]);

  // Seed the textarea when entering markdown mode.
  useEffect(() => {
    if (!editor) return;
    const md = htmlToMarkdown(editor.getHTML());
    markdownRef.current = md;
    dirtyRef.current = false;
    setMarkdown(md);
  }, [editor]);

  // Inbound: reflect remote / rich-editor changes into the textarea live.
  useEffect(() => {
    if (!editor) return;

    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged) return;
      if (transaction.getMeta(MARKDOWN_SYNC_META)) return; // our own echo
      // Defer past the current dispatch to avoid re-entrant transactions.
      queueMicrotask(reconcileFromEditor);
    };

    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

  // Flush any pending edit on unmount (mode switch / navigation).
  useEffect(() => {
    return () => {
      flushNow();
    };
  }, []);

  return (
    <Textarea
      ref={textareaRef}
      value={markdown}
      onChange={(e) => {
        const val = e.currentTarget.value;
        markdownRef.current = val;
        setMarkdown(val);
        if (editable) scheduleSync(val);
      }}
      readOnly={!editable}
      autosize
      minRows={20}
      styles={{
        input: {
          fontFamily: "monospace",
          fontSize: "14px",
          lineHeight: 1.6,
          border: "none",
          resize: "none",
          padding: 0,
          background: "transparent",
        },
        wrapper: { width: "100%" },
      }}
    />
  );
}
