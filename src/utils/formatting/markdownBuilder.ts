/**
 * @fileoverview Markdown builder utility for creating well-structured, semantic markdown content
 * @module utils/formatting/markdownBuilder
 */

/**
 * Utility class for building well-formatted markdown content with consistent structure.
 *
 * Provides a fluent API for creating markdown documents with proper spacing, hierarchy,
 * and semantic structure. Eliminates string concatenation and ensures consistent
 * formatting across tool response formatters. Each method appends to an internal buffer
 * and returns `this` for chaining; call {@link MarkdownBuilder.build} to produce the
 * final string.
 *
 * @example
 * ```typescript
 * const output = new MarkdownBuilder()
 *   .h1('Commit Created Successfully')
 *   .keyValue('Commit Hash', 'abc123def')
 *   .keyValue('Author', 'John Doe')
 *   .section('Files Changed', () => {
 *     // `section` calls the callback immediately; builder state is mutated in place
 *   })
 *   .list(['file1.ts', 'file2.ts'])
 *   .build();
 * ```
 *
 * @example
 * ```typescript
 * // Using the `markdown()` factory shorthand
 * import { markdown } from '@cyanheads/mcp-ts-core/utils';
 *
 * const md = markdown()
 *   .h2('Results')
 *   .table(['Name', 'Status'], [['foo', 'ok'], ['bar', 'fail']])
 *   .build();
 * ```
 */
export class MarkdownBuilder {
  private sections: string[] = [];

  /**
   * Add a level 1 heading (`# text`).
   *
   * @param text - The heading text
   * @param emoji - Optional emoji prepended before the text with a space
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * markdown().h1('Report').build();           // '# Report'
   * markdown().h1('Report', '📋').build();     // '# 📋 Report'
   * ```
   */
  h1(text: string, emoji?: string): this {
    const prefix = emoji ? `${emoji} ` : '';
    this.sections.push(`# ${prefix}${text}\n\n`);
    return this;
  }

  /**
   * Add a level 2 heading (`## text`).
   *
   * @param text - The heading text
   * @param emoji - Optional emoji prepended before the text with a space
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * markdown().h2('Section').build();   // '## Section'
   * ```
   */
  h2(text: string, emoji?: string): this {
    const prefix = emoji ? `${emoji} ` : '';
    this.sections.push(`## ${prefix}${text}\n\n`);
    return this;
  }

  /**
   * Add a level 3 heading (`### text`).
   *
   * @param text - The heading text
   * @param emoji - Optional emoji prepended before the text with a space
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * markdown().h3('Subsection').build();   // '### Subsection'
   * ```
   */
  h3(text: string, emoji?: string): this {
    const prefix = emoji ? `${emoji} ` : '';
    this.sections.push(`### ${prefix}${text}\n\n`);
    return this;
  }

  /**
   * Add a level 4 heading (`#### text`).
   *
   * @param text - The heading text
   * @param emoji - Optional emoji prepended before the text with a space
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * markdown().h4('Detail').build();   // '#### Detail'
   * ```
   */
  h4(text: string, emoji?: string): this {
    const prefix = emoji ? `${emoji} ` : '';
    this.sections.push(`#### ${prefix}${text}\n\n`);
    return this;
  }

  /**
   * Add a bold key-value pair on a single line (`**key:** value`).
   * `null` values are rendered as the string `'null'`.
   *
   * @param key - The key label, rendered in bold
   * @param value - The value; `null` renders as `'null'`
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * markdown().keyValue('Status', 'active').build();   // '**Status:** active'
   * markdown().keyValue('Count', 42).build();          // '**Count:** 42'
   * markdown().keyValue('Flag', null).build();         // '**Flag:** null'
   * ```
   */
  keyValue(key: string, value: string | number | boolean | null): this {
    const displayValue = value === null ? 'null' : String(value);
    this.sections.push(`**${key}:** ${displayValue}\n`);
    return this;
  }

  /**
   * Add a plain (unbolded) key-value pair on a single line (`key: value`).
   * Use when less visual emphasis is desired compared to {@link keyValue}.
   * `null` values are rendered as the string `'null'`.
   *
   * @param key - The key label, rendered without formatting
   * @param value - The value; `null` renders as `'null'`
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * markdown().keyValuePlain('host', 'localhost').build();   // 'host: localhost'
   * ```
   */
  keyValuePlain(key: string, value: string | number | boolean | null): this {
    const displayValue = value === null ? 'null' : String(value);
    this.sections.push(`${key}: ${displayValue}\n`);
    return this;
  }

  /**
   * Add a bulleted (`-`) or numbered list. Empty arrays are silently ignored.
   *
   * @param items - Array of string items to render
   * @param ordered - When `true`, renders a numbered list (`1.`, `2.`, …); defaults to `false` (bulleted)
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * markdown().list(['alpha', 'beta', 'gamma']).build();
   * // - alpha
   * // - beta
   * // - gamma
   *
   * markdown().list(['first', 'second'], true).build();
   * // 1. first
   * // 2. second
   * ```
   */
  list(items: string[], ordered = false): this {
    if (items.length === 0) return this;

    const marker = ordered ? (i: number) => `${i + 1}.` : () => '-';
    this.sections.push(`${items.map((item, i) => `${marker(i)} ${item}`).join('\n')}\n\n`);
    return this;
  }

  /**
   * Add a fenced code block with optional syntax highlighting.
   *
   * The fence is sized past the longest backtick run in `content`, per
   * CommonMark's rule that a fenced block closes only on a run at least as long
   * as the one that opened it. Content a tool did not author — an upstream
   * response, a file excerpt, a user-supplied field — therefore cannot break out
   * of its block and be reparsed as the tool's own output. Content is emitted
   * byte-for-byte, so it keeps parity with `structuredContent`, and a payload
   * with no three-backtick run renders exactly as it did before.
   *
   * @param content - The code content placed verbatim inside the fence
   * @param language - Language identifier for syntax highlighting (e.g. `'typescript'`, `'json'`, `'diff'`); defaults to no language
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * markdown().codeBlock('const x = 1;', 'typescript').build();
   * // ```typescript
   * // const x = 1;
   * // ```
   * ```
   */
  codeBlock(content: string, language = ''): this {
    // Iterated rather than collected: a payload that is mostly backticks yields
    // as many runs as it has characters, and arbitrary third-party text is
    // exactly the input this guards.
    let longestRun = 0;
    for (const [run] of content.matchAll(/`+/g)) longestRun = Math.max(longestRun, run.length);
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    this.sections.push(`${fence}${language}\n${content}\n${fence}\n\n`);
    return this;
  }

  /**
   * Append inline code wrapped in single backticks (`` `code` ``).
   * No trailing newline is added — suitable for inline use within a sentence.
   *
   * @param code - The code text to wrap
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * markdown().text('Call ').inlineCode('build()').text(' when done.').build();
   * // Call `build()` when done.
   * ```
   */
  inlineCode(code: string): this {
    this.sections.push(`\`${code}\``);
    return this;
  }

  /**
   * Add a paragraph of text followed by two newlines.
   *
   * @param text - The paragraph content
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * markdown().paragraph('Hello world.').paragraph('Second paragraph.').build();
   * // Hello world.
   * //
   * // Second paragraph.
   * ```
   */
  paragraph(text: string): this {
    this.sections.push(`${text}\n\n`);
    return this;
  }

  /**
   * Add a blockquote. Each line of `text` is prefixed with `> `.
   *
   * @param text - The quoted text; multi-line strings are handled correctly
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * markdown().blockquote('Line one\nLine two').build();
   * // > Line one
   * // > Line two
   * ```
   */
  blockquote(text: string): this {
    const lines = text.split('\n');
    const quoted = lines.map((line) => `> ${line}`).join('\n');
    this.sections.push(`${quoted}\n\n`);
    return this;
  }

  /**
   * Add a horizontal rule.
   * @returns this builder for chaining
   */
  hr(): this {
    this.sections.push('---\n\n');
    return this;
  }

  /**
   * Append an inline markdown link (`[text](url)`).
   * No trailing newline is added — suitable for inline use within a sentence.
   *
   * @param text - The visible link label
   * @param url - The link target URL
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * markdown().text('See ').link('the docs', 'https://example.com').text(' for details.').build();
   * // See [the docs](https://example.com) for details.
   * ```
   */
  link(text: string, url: string): this {
    this.sections.push(`[${text}](${url})`);
    return this;
  }

  /**
   * Add a GFM-style table. Returns without modification if `headers` or `rows` is empty.
   * All separator cells use `---`; no alignment syntax is applied.
   *
   * @param headers - Column header labels
   * @param rows - Data rows; each inner array should have the same length as `headers`
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * markdown().table(['Name', 'Status'], [['foo', 'ok'], ['bar', 'fail']]).build();
   * // | Name | Status |
   * // | --- | --- |
   * // | foo | ok |
   * // | bar | fail |
   * ```
   */
  table(headers: string[], rows: string[][]): this {
    if (headers.length === 0 || rows.length === 0) return this;

    // Header row
    this.sections.push(`| ${headers.join(' | ')} |\n`);

    // Separator row
    this.sections.push(`| ${headers.map(() => '---').join(' | ')} |\n`);

    // Data rows
    rows.forEach((row) => {
      this.sections.push(`| ${row.join(' | ')} |\n`);
    });

    this.sections.push('\n');
    return this;
  }

  /**
   * Add a headed section by rendering a heading then immediately invoking a callback.
   * The callback is called synchronously; any builder calls inside it mutate the same
   * instance. Defaults to heading level 2 when no level is provided.
   *
   * @param title - The section heading text
   * @param levelOrContent - Heading level (`2`|`3`|`4`) or callback when using the two-arg overload
   * @param content - Callback that appends section body content (required when `level` is provided)
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * const md = markdown();
   * md.section('Files Changed', () => {
   *   md.list(['file1.ts', 'file2.ts']);
   * });
   * // ## Files Changed
   * //
   * // - file1.ts
   * // - file2.ts
   *
   * md.section('Details', 3, () => {
   *   md.paragraph('Nested at level 3.');
   * });
   * // ### Details
   * //
   * // Nested at level 3.
   * ```
   */
  section(title: string, content: () => void): this;
  section(title: string, level: 2 | 3 | 4, content: () => void): this;
  section(title: string, levelOrContent: 2 | 3 | 4 | (() => void), content?: () => void): this {
    let level: 2 | 3 | 4;
    let callback: () => void;

    if (typeof levelOrContent === 'function') {
      level = 2;
      callback = levelOrContent;
    } else {
      level = levelOrContent;
      // Safe: the overload signatures guarantee content is provided when level is a number
      callback = content ?? (() => {});
    }

    switch (level) {
      case 2:
        this.h2(title);
        break;
      case 3:
        this.h3(title);
        break;
      case 4:
        this.h4(title);
        break;
    }
    callback();
    return this;
  }

  /**
   * Add a collapsible `<details>`/`<summary>` HTML block.
   * The `summary` is always visible; `details` content is collapsed by default.
   * Not all markdown renderers support this — GitHub and GitLab do.
   *
   * @param summary - The always-visible summary label
   * @param details - The collapsible body content (plain text or markdown)
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * markdown().details('Show stack trace', 'Error: something went wrong\n  at foo.ts:10').build();
   * // <details>
   * // <summary>Show stack trace</summary>
   * //
   * // Error: something went wrong
   * //   at foo.ts:10
   * //
   * // </details>
   * ```
   */
  details(summary: string, details: string): this {
    this.sections.push(`<details>\n<summary>${summary}</summary>\n\n`);
    this.sections.push(`${details}\n\n`);
    this.sections.push(`</details>\n\n`);
    return this;
  }

  /**
   * Add a status/alert box (GitHub/GitLab style).
   * Renders as a highlighted blockquote with an icon.
   *
   * Supported types:
   * - 'note': 📝 Neutral information
   * - 'tip': 💡 Helpful suggestions
   * - 'important': ❗ Critical information
   * - 'warning': ⚠️ Warning/caution
   * - 'caution': 🚨 Danger/destructive action
   *
   * @param type - Alert type
   * @param content - Alert content (can be multi-line)
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * md.alert('warning', 'This operation cannot be undone!');
   * // Renders: > [!WARNING]
   * //          > This operation cannot be undone!
   * ```
   */
  alert(type: 'note' | 'tip' | 'important' | 'warning' | 'caution', content: string): this {
    const typeUpper = type.toUpperCase();
    const lines = content.split('\n');
    this.sections.push(`> [!${typeUpper}]\n`);
    lines.forEach((line) => {
      this.sections.push(`> ${line}\n`);
    });
    this.sections.push('\n');
    return this;
  }

  /**
   * Add a task list with checkboxes (GitHub style).
   *
   * @param items - Array of tasks with checked status
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * md.taskList([
   *   { checked: true, text: 'Complete setup' },
   *   { checked: false, text: 'Run tests' },
   * ]);
   * // Renders: - [x] Complete setup
   * //          - [ ] Run tests
   * ```
   */
  taskList(items: Array<{ checked: boolean; text: string }>): this {
    if (items.length === 0) return this;

    this.sections.push(
      `${items.map((item) => `- [${item.checked ? 'x' : ' '}] ${item.text}`).join('\n')}\n\n`,
    );
    return this;
  }

  /**
   * Add an image with alt text and optional title.
   *
   * @param altText - Alternative text for the image
   * @param url - Image URL
   * @param title - Optional title (shown on hover)
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * md.image('Architecture diagram', '/assets/diagram.png', 'System Architecture');
   * // Renders: ![Architecture diagram](/assets/diagram.png "System Architecture")
   * ```
   */
  image(altText: string, url: string, title?: string): this {
    const titlePart = title ? ` "${title}"` : '';
    this.sections.push(`![${altText}](${url}${titlePart})\n\n`);
    return this;
  }

  /**
   * Add strikethrough text.
   *
   * @param text - Text to strike through
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * md.text('Price: ').strikethrough('$100').text(' $80');
   * // Renders: Price: ~~$100~~ $80
   * ```
   */
  strikethrough(text: string): this {
    this.sections.push(`~~${text}~~`);
    return this;
  }

  /**
   * Add a `diff`-language fenced code block showing additions and deletions.
   * Rendering order: context lines (two-space indent) → deletions (`- ` prefix) → additions (`+ ` prefix).
   * If all three arrays are empty or omitted, nothing is appended.
   *
   * @param changes - Line arrays for the diff
   * @param changes.context - Unchanged context lines (rendered with two-space indent)
   * @param changes.deletions - Removed lines (rendered with `- ` prefix)
   * @param changes.additions - Added lines (rendered with `+ ` prefix)
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * markdown().diff({
   *   context: ['// Configuration'],
   *   deletions: ['const oldFeature = false;'],
   *   additions: ['const newFeature = true;'],
   * }).build();
   * // ```diff
   * //   // Configuration
   * // - const oldFeature = false;
   * // + const newFeature = true;
   * // ```
   * ```
   */
  diff(changes: { additions?: string[]; deletions?: string[]; context?: string[] }): this {
    const lines: string[] = [];

    // Context lines (no prefix)
    if (changes.context) {
      lines.push(...changes.context.map((line) => `  ${line}`));
    }

    // Deletions (- prefix)
    if (changes.deletions) {
      lines.push(...changes.deletions.map((line) => `- ${line}`));
    }

    // Additions (+ prefix)
    if (changes.additions) {
      lines.push(...changes.additions.map((line) => `+ ${line}`));
    }

    if (lines.length > 0) {
      this.codeBlock(lines.join('\n'), 'diff');
    }

    return this;
  }

  /**
   * Add a badge/shield (uses shields.io style).
   *
   * @param label - Badge label (left side)
   * @param message - Badge message (right side)
   * @param color - Optional color (e.g., 'green', 'red', 'blue', 'yellow')
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * md.badge('build', 'passing', 'green');
   * // Renders: ![build: passing](https://img.shields.io/badge/build-passing-green)
   * ```
   */
  badge(label: string, message: string, color = 'blue'): this {
    const encodedLabel = encodeURIComponent(label);
    const encodedMessage = encodeURIComponent(message);
    const url = `https://img.shields.io/badge/${encodedLabel}-${encodedMessage}-${color}`;
    this.sections.push(`![${label}: ${message}](${url})`);
    return this;
  }

  /**
   * Add bold text.
   *
   * @param text - Text to make bold
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * md.text('This is ').bold('important').text(' information.');
   * // Renders: This is **important** information.
   * ```
   */
  bold(text: string): this {
    this.sections.push(`**${text}**`);
    return this;
  }

  /**
   * Add italic text.
   *
   * @param text - Text to make italic
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * md.text('This is ').italic('emphasized').text('.');
   * // Renders: This is *emphasized*.
   * ```
   */
  italic(text: string): this {
    this.sections.push(`*${text}*`);
    return this;
  }

  /**
   * Add bold and italic text.
   *
   * @param text - Text to make bold and italic
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * md.boldItalic('Very important');
   * // Renders: ***Very important***
   * ```
   */
  boldItalic(text: string): this {
    this.sections.push(`***${text}***`);
    return this;
  }

  /**
   * Append a raw markdown string directly to the buffer without any transformation.
   * Use this for custom formatting not covered by other methods.
   *
   * @param markdown - Raw markdown string appended verbatim
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * markdown().raw('> custom blockquote\n\n').build();
   * // > custom blockquote
   * ```
   */
  raw(markdown: string): this {
    this.sections.push(markdown);
    return this;
  }

  /**
   * Add a blank line for spacing.
   * @returns this builder for chaining
   */
  blankLine(): this {
    this.sections.push('\n');
    return this;
  }

  /**
   * Append plain text without any markdown formatting or implicit line breaks.
   * Useful for building inline content by interleaving with methods like
   * {@link bold}, {@link italic}, {@link inlineCode}, and {@link link}.
   *
   * @param text - The text to append verbatim
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * markdown().text('Result: ').bold('42').text(' items found.').build();
   * // Result: **42** items found.
   * ```
   */
  text(text: string): this {
    this.sections.push(text);
    return this;
  }

  /**
   * Conditionally append content. The callback is invoked synchronously only when
   * `condition` is `true`; otherwise the builder is returned unchanged.
   *
   * @param condition - When `true`, the callback is invoked
   * @param content - Callback that appends content to this builder
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * md.when(files.length > 0, () => {
   *   md.h2('Files Changed').list(files);
   * });
   * ```
   */
  when(condition: boolean, content: () => void): this {
    if (condition) {
      content();
    }
    return this;
  }

  /**
   * Concatenate all buffered sections and return the final markdown string.
   * Leading and trailing whitespace is trimmed so documents always end cleanly.
   * The builder instance is NOT reset — call {@link reset} explicitly if reuse is needed.
   *
   * @returns The complete markdown document as a trimmed string
   *
   * @example
   * ```typescript
   * const output = markdown().h1('Hello').paragraph('World').build();
   * // '# Hello\n\nWorld'
   * ```
   */
  build(): string {
    return this.sections.join('').trim();
  }

  /**
   * Clear all buffered content so the builder can be reused for a new document.
   *
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * const md = markdown().h1('Draft');
   * md.reset().h1('Final').build();   // '# Final'
   * ```
   */
  reset(): this {
    this.sections = [];
    return this;
  }
}

/**
 * Factory function that creates a new {@link MarkdownBuilder} instance.
 * Prefer this over `new MarkdownBuilder()` for concise call-site syntax.
 *
 * @returns A fresh, empty `MarkdownBuilder`
 *
 * @example
 * ```typescript
 * import { markdown } from '@cyanheads/mcp-ts-core/utils';
 *
 * const output = markdown()
 *   .h1('Summary')
 *   .keyValue('Total', 5)
 *   .build();
 * ```
 */
export function markdown(): MarkdownBuilder {
  return new MarkdownBuilder();
}
