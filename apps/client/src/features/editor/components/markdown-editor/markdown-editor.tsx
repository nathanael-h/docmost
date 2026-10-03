import { useEffect, useRef, useState } from "react";
import { Textarea } from "@mantine/core";
import { useDebouncedCallback } from "@mantine/hooks";
import { Editor, generateJSON, type JSONContent } from "@tiptap/core";
import { Fragment, Node as ProsemirrorNode, Slice } from "@tiptap/pm/model";
import { htmlToMarkdown, markdownToHtml } from "@docmost/editor-ext";
import { mainExtensions } from "@/features/editor/extensions/extensions";

function applyMarkdownUpdate(editor: Editor, newDocJson: JSONContent) {
  const { state } = editor;
  const oldDoc = state.doc;
  const newDoc = state.schema.nodeFromJSON(newDocJson);

  if (JSON.stringify(oldDoc.toJSON()) === JSON.stringify(newDocJson)) return;

  // Find unchanged prefix length (top-level nodes matching from start)
  let prefix = 0;
  const minLen = Math.min(oldDoc.childCount, newDoc.childCount);
  while (
    prefix < minLen &&
    JSON.stringify(oldDoc.child(prefix).toJSON()) ===
      JSON.stringify(newDoc.child(prefix).toJSON())
  ) {
    prefix++;
  }

  // Find unchanged suffix length (no overlap with prefix)
  let suffix = 0;
  while (
    suffix < oldDoc.childCount - prefix &&
    suffix < newDoc.childCount - prefix &&
    JSON.stringify(
      oldDoc.child(oldDoc.childCount - 1 - suffix).toJSON(),
    ) ===
      JSON.stringify(newDoc.child(newDoc.childCount - 1 - suffix).toJSON())
  ) {
    suffix++;
  }

  // Compute document positions for the changed range in the old doc
  let fromPos = 0;
  for (let i = 0; i < prefix; i++) fromPos += oldDoc.child(i).nodeSize;
  let toPos = oldDoc.content.size;
  for (let i = 0; i < suffix; i++)
    toPos -= oldDoc.child(oldDoc.childCount - 1 - i).nodeSize;

  // Collect replacement nodes from the new doc
  const nodes: ProsemirrorNode[] = [];
  for (let i = prefix; i < newDoc.childCount - suffix; i++)
    nodes.push(newDoc.child(i));

  const tr = state.tr.replace(
    fromPos,
    toPos,
    new Slice(Fragment.from(nodes), 0, 0),
  );
  editor.view.dispatch(tr);
}

interface MarkdownEditorProps {
  editor: Editor | null;
  editable: boolean;
}

export function MarkdownEditor({ editor, editable }: MarkdownEditorProps) {
  const [markdown, setMarkdown] = useState("");

  // Refs track current values for the unmount cleanup (avoids stale closures)
  const markdownRef = useRef("");
  const initializedRef = useRef(false);
  const editorRef = useRef(editor);
  const editableRef = useRef(editable);
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);
  useEffect(() => {
    editableRef.current = editable;
  }, [editable]);

  // Seed textarea from TipTap when entering markdown mode
  useEffect(() => {
    if (!editor) return;
    const md = htmlToMarkdown(editor.getHTML());
    setMarkdown(md);
    markdownRef.current = md;
    initializedRef.current = true;
  }, [editor]);

  // Debounced fine-grained sync on each keystroke (block-level diff → targeted Yjs ops)
  const syncToEditor = useDebouncedCallback((md: string) => {
    if (!editorRef.current) return;
    const html = markdownToHtml(md) as string;
    const json = generateJSON(html, mainExtensions);
    applyMarkdownUpdate(editorRef.current, json);
  }, 500);

  // Final flush on unmount — catches mode switch within the debounce window
  useEffect(() => {
    return () => {
      if (!editorRef.current || !initializedRef.current) return;
      const html = markdownToHtml(markdownRef.current) as string;
      const json = generateJSON(html, mainExtensions);
      applyMarkdownUpdate(editorRef.current, json);
    };
  }, []);

  return (
    <Textarea
      value={markdown}
      onChange={(e) => {
        const val = e.currentTarget.value;
        setMarkdown(val);
        markdownRef.current = val;
        if (editable) syncToEditor(val);
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
