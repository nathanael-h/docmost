import * as _TurndownService from '@joplin/turndown';
import * as TurndownPluginGfm from '@joplin/turndown-plugin-gfm';
import { getBasename } from './basename';

// CJS/ESM interop: .default exists in Vite, not in NestJS
const TurndownService = (_TurndownService as any).default || _TurndownService;

function sanitizeMdLinkText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/([\[\]!])/g, '\\$1')
    .replace(/[\r\n]+/g, ' ');
}

export function htmlToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    hr: '---',
    bulletListMarker: '-',
  });

  turndownService.use([
    TurndownPluginGfm.tables,
    TurndownPluginGfm.strikethrough,
    TurndownPluginGfm.highlightedCodeBlock,
    taskList,
    callout,
    preserveDetail,
    listParagraph,
    orderedListItem,
    mathInline,
    mathBlock,
    iframeEmbed,
    // Generic tag rules first (lower priority — added earlier)
    image,
    video,
    // Docmost-specific rules last (higher priority — override generic rules for
    // internal attachments and handle nodes that have no generic counterpart)
    pageBreak,
    subpages,
    columns,
    status,
    transclusionSource,
    transclusionReference,
    embed,
    drawio,
    excalidraw,
    docmostAudio,
    docmostPdf,
    attachment,
    docmostImage,
    docmostVideo,
  ]);
  return turndownService.turndown(html).replaceAll('<br>', ' ');
}

function listParagraph(turndownService: _TurndownService) {
  turndownService.addRule('paragraph', {
    filter: ['p'],
    replacement: (content: string, node: HTMLInputElement) => {
      if (node.parentElement?.nodeName === 'LI') {
        return content;
      }
      return `\n\n${content}\n\n`;
    },
  });
}

function orderedListItem(turndownService: _TurndownService) {
  turndownService.addRule('orderedListItem', {
    filter: function (node: HTMLInputElement) {
      return node.nodeName === 'LI' && node.getAttribute('data-type') !== 'taskItem';
    },
    replacement: (content: string, node: HTMLInputElement, options: any) => {
      const parent = node.parentNode as HTMLElement;
      if (parent.nodeName !== 'OL' && parent.nodeName !== 'UL') {
        return content;
      }

      content = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n')
        .replace(/\n/gm, '\n  ');

      let prefix: string;
      if (parent.nodeName === 'OL') {
        const start = parseInt(parent.getAttribute('start') || '1', 10);
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start + index}. `;
      } else {
        prefix = `${options.bulletListMarker} `;
      }

      return (
        prefix +
        content +
        (node.nextSibling && !/\n$/.test(content) ? '\n' : '')
      );
    },
  });
}

function callout(turndownService: _TurndownService) {
  turndownService.addRule('callout', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'DIV' && node.getAttribute('data-type') === 'callout'
      );
    },
    replacement: function (content: string, node: HTMLInputElement) {
      const calloutType = node.getAttribute('data-callout-type');
      return `\n\n:::${calloutType}\n${content.trim()}\n:::\n\n`;
    },
  });
}

function taskList(turndownService: _TurndownService) {
  turndownService.addRule('taskListItem', {
    filter: function (node: HTMLInputElement) {
      return (
        node.getAttribute('data-type') === 'taskItem' &&
        node.parentNode.nodeName === 'UL'
      );
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const isChecked = node.getAttribute('data-checked') === 'true';
      const div = node.querySelector('div');
      const text = div ? div.textContent.trim() : node.textContent.trim();

      const prefix = `- ${isChecked ? '[x]' : '[ ]'} `;

      return (
        prefix +
        text +
        (node.nextSibling && !/\n$/.test(text) ? '\n' : '')
      );
    },
  });
}

function preserveDetail(turndownService: _TurndownService) {
  turndownService.addRule('preserveDetail', {
    filter: function (node: HTMLInputElement) {
      return node.nodeName === 'DETAILS';
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const summary = node.querySelector(':scope > summary');
      let detailSummary = '';

      if (summary) {
        detailSummary = `<summary>${turndownService.turndown(summary.innerHTML)}</summary>`;
      }

      const detailsContent = Array.from(node.childNodes)
        .filter((child) => child.nodeName !== 'SUMMARY')
        .map((child) =>
          child.nodeType === 1
            ? turndownService.turndown((child as HTMLElement).outerHTML)
            : child.textContent,
        )
        .join('');

      return `\n<details>\n${detailSummary}\n\n${detailsContent}\n\n</details>\n`;
    },
  });
}

function mathInline(turndownService: _TurndownService) {
  turndownService.addRule('mathInline', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'SPAN' &&
        node.getAttribute('data-type') === 'mathInline'
      );
    },
    replacement: function (content: string) {
      return `$${content}$`;
    },
  });
}

function mathBlock(turndownService: _TurndownService) {
  turndownService.addRule('mathBlock', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'DIV' &&
        node.getAttribute('data-type') === 'mathBlock'
      );
    },
    replacement: function (content: string) {
      return `\n$$\n${content}\n$$\n`;
    },
  });
}

function iframeEmbed(turndownService: _TurndownService) {
  turndownService.addRule('iframeEmbed', {
    filter: function (node: HTMLInputElement) {
      return node.nodeName === 'IFRAME';
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const src = node.getAttribute('src');
      return '[' + src + '](' + src + ')';
    },
  });
}

function image(turndownService: _TurndownService) {
  turndownService.addRule('image', {
    filter: 'img',
    replacement: function (_content: string, node: HTMLInputElement) {
      const src = node.getAttribute('src') || '';
      if (!src) return '';
      const alt = sanitizeMdLinkText(node.getAttribute('alt') || '');
      const title = node.getAttribute('title') || '';
      const titlePart = title ? ' "' + title.replace(/"/g, '\\"') + '"' : '';
      return '![' + alt + '](' + src + titlePart + ')';
    },
  });
}

function video(turndownService: _TurndownService) {
  turndownService.addRule('video', {
    filter: function (node: HTMLInputElement) {
      return node.tagName === 'VIDEO';
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const src = node.getAttribute('src') || '';
      const ariaLabel = node.getAttribute('aria-label');
      const name = sanitizeMdLinkText(
        ariaLabel || getBasename(src) || src,
      );
      return '[' + name + '](' + src + ')';
    },
  });
}

function pageBreak(turndownService: _TurndownService) {
  turndownService.addRule('pageBreak', {
    filter: (node: HTMLInputElement) =>
      node.nodeName === 'DIV' && node.getAttribute('data-type') === 'pageBreak',
    replacement: () =>
      '\n\n<div data-type="pageBreak" class="page-break"></div>\n\n',
  });
}

function subpages(turndownService: _TurndownService) {
  turndownService.addRule('subpages', {
    filter: (node: HTMLInputElement) =>
      node.nodeName === 'DIV' && node.getAttribute('data-type') === 'subpages',
    replacement: () => '\n\n<div data-type="subpages"></div>\n\n',
  });
}

function columns(turndownService: _TurndownService) {
  turndownService.addRule('columns', {
    filter: (node: HTMLInputElement) =>
      node.nodeName === 'DIV' && node.getAttribute('data-type') === 'columns',
    replacement: (_content: string, node: any) =>
      `\n\n${node.outerHTML}\n\n`,
  });
}

function status(turndownService: _TurndownService) {
  turndownService.addRule('status', {
    filter: (node: HTMLInputElement) =>
      node.nodeName === 'SPAN' && node.getAttribute('data-type') === 'status',
    replacement: (_content: string, node: any) => {
      const color = node.getAttribute('data-color') || 'gray';
      const text = (node.textContent || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<span data-type="status" data-color="${color}">${text}</span>`;
    },
  });
}

function transclusionSource(turndownService: _TurndownService) {
  turndownService.addRule('transclusionSource', {
    filter: (node: HTMLInputElement) =>
      node.nodeName === 'DIV' &&
      node.getAttribute('data-type') === 'transclusionSource',
    replacement: (content: string) => `\n\n${content}\n\n`,
  });
}

function transclusionReference(turndownService: _TurndownService) {
  turndownService.addRule('transclusionReference', {
    filter: (node: HTMLInputElement) =>
      node.nodeName === 'DIV' &&
      node.getAttribute('data-type') === 'transclusionReference',
    replacement: (_content: string, node: any) => {
      const sourcePageId = node.getAttribute('data-source-page-id') || '';
      const transclusionId = node.getAttribute('data-transclusion-id') || '';
      return `\n\n<div data-type="transclusionReference" data-source-page-id="${sourcePageId}" data-transclusion-id="${transclusionId}"></div>\n\n`;
    },
  });
}

function embed(turndownService: _TurndownService) {
  turndownService.addRule('embed', {
    filter: (node: HTMLInputElement) =>
      node.nodeName === 'DIV' && node.getAttribute('data-type') === 'embed',
    replacement: (_content: string, node: any) => {
      const src = (node.getAttribute('data-src') || '')
        .replace(/"/g, '&quot;');
      const provider = (node.getAttribute('data-provider') || '')
        .replace(/"/g, '&quot;');
      const align = node.getAttribute('data-align') || 'center';
      const width = node.getAttribute('data-width') || '800';
      const height = node.getAttribute('data-height') || '600';
      return `\n\n<div data-type="embed" data-src="${src}" data-provider="${provider}" data-align="${align}" data-width="${width}" data-height="${height}"></div>\n\n`;
    },
  });
}

function drawio(turndownService: _TurndownService) {
  turndownService.addRule('drawio', {
    filter: (node: HTMLInputElement) =>
      node.nodeName === 'DIV' && node.getAttribute('data-type') === 'drawio',
    replacement: (_content: string, node: any) =>
      `\n\n${node.outerHTML}\n\n`,
  });
}

function excalidraw(turndownService: _TurndownService) {
  turndownService.addRule('excalidraw', {
    filter: (node: HTMLInputElement) =>
      node.nodeName === 'DIV' &&
      node.getAttribute('data-type') === 'excalidraw',
    replacement: (_content: string, node: any) =>
      `\n\n${node.outerHTML}\n\n`,
  });
}

function docmostAudio(turndownService: _TurndownService) {
  turndownService.addRule('docmostAudio', {
    filter: (node: HTMLInputElement) => node.nodeName === 'AUDIO',
    replacement: (_content: string, node: any) =>
      `\n\n${node.outerHTML}\n\n`,
  });
}

function docmostPdf(turndownService: _TurndownService) {
  turndownService.addRule('docmostPdf', {
    filter: (node: HTMLInputElement) =>
      node.nodeName === 'DIV' && node.getAttribute('data-type') === 'pdf',
    replacement: (_content: string, node: any) =>
      `\n\n${node.outerHTML}\n\n`,
  });
}

function attachment(turndownService: _TurndownService) {
  turndownService.addRule('attachment', {
    filter: (node: HTMLInputElement) =>
      node.nodeName === 'DIV' &&
      node.getAttribute('data-type') === 'attachment',
    replacement: (_content: string, node: any) =>
      `\n\n${node.outerHTML}\n\n`,
  });
}

// Internal images (with attachmentId) — preserve all metadata as HTML
function docmostImage(turndownService: _TurndownService) {
  turndownService.addRule('docmostImage', {
    filter: (node: HTMLInputElement) =>
      node.nodeName === 'IMG' &&
      node.getAttribute('data-attachment-id') !== null,
    replacement: (_content: string, node: any) =>
      `\n\n${node.outerHTML}\n\n`,
  });
}

// Internal videos (with attachmentId) — preserve all metadata as HTML
function docmostVideo(turndownService: _TurndownService) {
  turndownService.addRule('docmostVideo', {
    filter: (node: HTMLInputElement) =>
      node.nodeName === 'VIDEO' &&
      node.getAttribute('data-attachment-id') !== null,
    replacement: (_content: string, node: any) =>
      `\n\n${node.outerHTML}\n\n`,
  });
}
