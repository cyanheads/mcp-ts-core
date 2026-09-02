/**
 * @fileoverview Tests for MarkdownBuilder utility
 * @module tests/utils/formatting/markdownBuilder.test
 */
import { describe, expect, test } from 'vitest';

import { MarkdownBuilder, markdown } from '@/utils/formatting/markdownBuilder.js';

describe('MarkdownBuilder', () => {
  describe('Basic instantiation', () => {
    test('should create instance via constructor', () => {
      const md = new MarkdownBuilder();
      expect(md).toBeInstanceOf(MarkdownBuilder);
      expect(md.build()).toBe('');
    });

    test('should create instance via helper function', () => {
      const md = markdown();
      expect(md).toBeInstanceOf(MarkdownBuilder);
      expect(md.build()).toBe('');
    });
  });

  describe('Headings', () => {
    test('should create h1 heading', () => {
      const result = markdown().h1('Title').build();
      expect(result).toBe('# Title');
    });

    test('should create h1 with emoji', () => {
      const result = markdown().h1('Success', '✅').build();
      expect(result).toBe('# ✅ Success');
    });

    test('should create h2 heading', () => {
      const result = markdown().h2('Section').build();
      expect(result).toBe('## Section');
    });

    test('should create h2 with emoji', () => {
      const result = markdown().h2('Details', '📋').build();
      expect(result).toBe('## 📋 Details');
    });

    test('should create h3 heading', () => {
      const result = markdown().h3('Subsection').build();
      expect(result).toBe('### Subsection');
    });

    test('should create h3 with emoji', () => {
      const result = markdown().h3('Info', 'ℹ️').build();
      expect(result).toBe('### ℹ️ Info');
    });

    test('should create h4 heading', () => {
      const result = markdown().h4('Minor heading').build();
      expect(result).toBe('#### Minor heading');
    });

    test('should create h4 with emoji', () => {
      const result = markdown().h4('Detail', '🔍').build();
      expect(result).toBe('#### 🔍 Detail');
    });

    test('should chain multiple headings', () => {
      const result = markdown().h1('Title').h2('Section').h3('Subsection').build();
      expect(result).toBe('# Title\n\n## Section\n\n### Subsection');
    });
  });

  describe('Key-value pairs', () => {
    test('should create bold key-value pair', () => {
      const result = markdown().keyValue('Name', 'John Doe').build();
      expect(result).toBe('**Name:** John Doe');
    });

    test('should handle numeric values', () => {
      const result = markdown().keyValue('Count', 42).build();
      expect(result).toBe('**Count:** 42');
    });

    test('should handle boolean values', () => {
      const result = markdown().keyValue('Enabled', true).build();
      expect(result).toBe('**Enabled:** true');
    });

    test('should handle null values', () => {
      const result = markdown().keyValue('Value', null).build();
      expect(result).toBe('**Value:** null');
    });

    test('should create plain key-value pair', () => {
      const result = markdown().keyValuePlain('Status', 'active').build();
      expect(result).toBe('Status: active');
    });

    test('should handle numeric values in plain key-value', () => {
      const result = markdown().keyValuePlain('Count', 42).build();
      expect(result).toBe('Count: 42');
    });

    test('should handle boolean values in plain key-value', () => {
      const result = markdown().keyValuePlain('Enabled', false).build();
      expect(result).toBe('Enabled: false');
    });

    test('should handle null values in plain key-value', () => {
      const result = markdown().keyValuePlain('Value', null).build();
      expect(result).toBe('Value: null');
    });

    test('should chain multiple key-value pairs', () => {
      const result = markdown().keyValue('Name', 'Test').keyValue('Age', 25).build();
      expect(result).toBe('**Name:** Test\n**Age:** 25');
    });
  });

  describe('Lists', () => {
    test('should create unordered list', () => {
      const result = markdown().list(['Item 1', 'Item 2', 'Item 3']).build();
      expect(result).toBe('- Item 1\n- Item 2\n- Item 3');
    });

    test('should create ordered list', () => {
      const result = markdown().list(['First', 'Second', 'Third'], true).build();
      expect(result).toBe('1. First\n2. Second\n3. Third');
    });

    test('should handle empty list', () => {
      const result = markdown().list([]).build();
      expect(result).toBe('');
    });

    test('should handle single item', () => {
      const result = markdown().list(['Single']).build();
      expect(result).toBe('- Single');
    });
  });

  describe('Code blocks', () => {
    test('should create code block without language', () => {
      const result = markdown().codeBlock('const x = 42;').build();
      expect(result).toBe('```\nconst x = 42;\n```');
    });

    test('should create code block with language', () => {
      const result = markdown().codeBlock('const x = 42;', 'typescript').build();
      expect(result).toBe('```typescript\nconst x = 42;\n```');
    });

    test('should create inline code', () => {
      const result = markdown().text('Use ').inlineCode('npm install').text(' to install.').build();
      expect(result).toBe('Use `npm install` to install.');
    });

    test('should keep a fenced payload inside the block', () => {
      const upstream = 'before\n```\nfenced\n```\nafter';

      const result = markdown().codeBlock(upstream, 'text').build();

      expect(result).toBe(`\`\`\`\`text\n${upstream}\n\`\`\`\``);
    });

    test('should outgrow the longest backtick run in the payload', () => {
      const upstream = 'a\n`````\nb\n````\nc';

      const result = markdown().codeBlock(upstream).build();

      expect(result).toBe(`\`\`\`\`\`\`\n${upstream}\n\`\`\`\`\`\``);
    });

    test('should leave short backtick runs on the default fence', () => {
      const upstream = 'inline `code` and a ``double`` run';

      const result = markdown().codeBlock(upstream, 'md').build();

      expect(result).toBe(`\`\`\`md\n${upstream}\n\`\`\``);
    });

    test('should emit the payload byte-for-byte between the fences', () => {
      const upstream = '```json\n{"a":1}\n```\ntrailing `` text';

      const lines = markdown().codeBlock(upstream, 'text').build().split('\n');

      expect(lines.slice(1, -1).join('\n')).toBe(upstream);
    });

    test('should size the fence for a payload made almost entirely of backtick runs', () => {
      // 200k separate runs: spreading these into `Math.max` exceeds the engine's
      // argument limit, and third-party text is exactly this method's input.
      const upstream = '`x'.repeat(200_000);

      const result = markdown().codeBlock(upstream).build();

      expect(result.startsWith('```\n')).toBe(true);
      expect(result.endsWith('\n```')).toBe(true);
    });

    test('should size a diff block for file content that is itself fenced', () => {
      const result = markdown()
        .diff({ additions: ['```ts'], deletions: ['```js'], context: ['# README'] })
        .build();

      expect(result).toBe('````diff\n  # README\n- ```js\n+ ```ts\n````');
    });
  });

  describe('Paragraphs and text', () => {
    test('should create paragraph', () => {
      const result = markdown().paragraph('This is a paragraph.').build();
      expect(result).toBe('This is a paragraph.');
    });

    test('should chain paragraphs', () => {
      const result = markdown()
        .paragraph('First paragraph.')
        .paragraph('Second paragraph.')
        .build();
      expect(result).toBe('First paragraph.\n\nSecond paragraph.');
    });

    test('should add text without formatting', () => {
      const result = markdown().text('Plain text').build();
      expect(result).toBe('Plain text');
    });
  });

  describe('Blockquotes', () => {
    test('should create single-line blockquote', () => {
      const result = markdown().blockquote('This is a quote.').build();
      expect(result).toBe('> This is a quote.');
    });

    test('should create multi-line blockquote', () => {
      const result = markdown().blockquote('Line 1\nLine 2\nLine 3').build();
      expect(result).toBe('> Line 1\n> Line 2\n> Line 3');
    });
  });

  describe('Horizontal rule', () => {
    test('should create horizontal rule', () => {
      const result = markdown().hr().build();
      expect(result).toBe('---');
    });

    test('should use hr as separator', () => {
      const result = markdown().paragraph('Before').hr().paragraph('After').build();
      expect(result).toBe('Before\n\n---\n\nAfter');
    });
  });

  describe('Links', () => {
    test('should create link', () => {
      const result = markdown().link('Google', 'https://google.com').build();
      expect(result).toBe('[Google](https://google.com)');
    });

    test('should integrate link in text', () => {
      const result = markdown()
        .text('Visit ')
        .link('our site', 'https://example.com')
        .text(' for more info.')
        .build();
      expect(result).toBe('Visit [our site](https://example.com) for more info.');
    });
  });

  describe('Tables', () => {
    test('should create table', () => {
      const result = markdown()
        .table(
          ['Name', 'Age', 'City'],
          [
            ['Alice', '30', 'NYC'],
            ['Bob', '25', 'LA'],
          ],
        )
        .build();
      expect(result).toBe(
        '| Name | Age | City |\n| --- | --- | --- |\n| Alice | 30 | NYC |\n| Bob | 25 | LA |',
      );
    });

    test('should handle empty headers', () => {
      const result = markdown().table([], []).build();
      expect(result).toBe('');
    });

    test('should handle empty rows', () => {
      const result = markdown().table(['Col1', 'Col2'], []).build();
      expect(result).toBe('');
    });
  });

  describe('Sections', () => {
    test('should create section with default level (h2)', () => {
      const md = markdown();
      const result = md
        .section('Files', () => {
          md.list(['file1.ts', 'file2.ts']);
        })
        .build();
      expect(result).toContain('## Files');
      expect(result).toContain('- file1.ts');
    });

    test('should create section with level 3', () => {
      const md = markdown();
      const result = md
        .section('Details', 3, () => {
          md.paragraph('Some details');
        })
        .build();
      expect(result).toContain('### Details');
      expect(result).toContain('Some details');
    });

    test('should create section with level 4', () => {
      const md = markdown();
      const result = md
        .section('Sub-detail', 4, () => {
          md.paragraph('Deep content');
        })
        .build();
      expect(result).toContain('#### Sub-detail');
      expect(result).toContain('Deep content');
    });
  });

  describe('Details/summary', () => {
    test('should create collapsible details', () => {
      const result = markdown().details('Click to expand', 'Hidden content here').build();
      expect(result).toContain('<details>');
      expect(result).toContain('<summary>Click to expand</summary>');
      expect(result).toContain('Hidden content here');
      expect(result).toContain('</details>');
    });
  });

  describe('Raw markdown', () => {
    test('should add raw markdown', () => {
      const result = markdown().raw('**Custom** _formatting_').build();
      expect(result).toBe('**Custom** _formatting_');
    });
  });

  describe('Blank lines', () => {
    test('should add blank line', () => {
      const result = markdown().text('Line 1').blankLine().text('Line 2').build();
      expect(result).toBe('Line 1\nLine 2');
    });
  });

  describe('Conditional content', () => {
    test('should add content when condition is true', () => {
      const hasTimestamp = true;
      const result = markdown()
        .h1('Report')
        .when(hasTimestamp, () => {
          markdown().keyValue('Timestamp', '2024-01-01');
        })
        .build();
      // Note: The when callback should use the same instance
      expect(result).toContain('# Report');
    });

    test('should not add content when condition is false', () => {
      const md = markdown();
      const result = md
        .h1('Report')
        .when(false, () => {
          md.keyValue('Timestamp', '2024-01-01');
        })
        .build();
      expect(result).toBe('# Report');
    });

    test('should use when with proper instance reference', () => {
      const md = markdown();
      const hasDetails = true;
      const result = md
        .h1('Document')
        .when(hasDetails, () => {
          md.paragraph('Additional details');
        })
        .build();
      expect(result).toContain('# Document');
      expect(result).toContain('Additional details');
    });
  });

  describe('Reset', () => {
    test('should reset builder state', () => {
      const md = markdown();
      md.h1('First').paragraph('Content');
      expect(md.build()).toContain('First');

      md.reset();
      expect(md.build()).toBe('');

      md.h1('Second');
      expect(md.build()).toBe('# Second');
      expect(md.build()).not.toContain('First');
    });
  });

  describe('Complex compositions', () => {
    test('should build complex document', () => {
      const md = markdown();
      const result = md
        .h1('Commit Summary', '✅')
        .keyValue('Hash', 'abc123')
        .keyValue('Author', 'John Doe')
        .keyValue('Date', '2024-01-01')
        .blankLine()
        .section('Files Changed', 2, () => {
          md.list(['src/file1.ts', 'src/file2.ts', 'tests/file1.test.ts']);
        })
        .section('Changes', 2, () => {
          md.codeBlock('+  new line\n-  old line', 'diff');
        })
        .build();

      expect(result).toContain('# ✅ Commit Summary');
      expect(result).toContain('**Hash:** abc123');
      expect(result).toContain('## Files Changed');
      expect(result).toContain('- src/file1.ts');
      expect(result).toContain('## Changes');
      expect(result).toContain('```diff');
    });

    test('should build tool response format', () => {
      const md = markdown();
      const timestamp = '2024-01-01T12:00:00Z';
      const result = md
        .paragraph('Echo (mode=uppercase, repeat=2)')
        .paragraph('HELLO WORLD HELLO WORLD')
        .when(!!timestamp, () => {
          md.keyValuePlain('timestamp', timestamp);
        })
        .build();

      expect(result).toContain('Echo (mode=uppercase, repeat=2)');
      expect(result).toContain('HELLO WORLD HELLO WORLD');
      expect(result).toContain('timestamp: 2024-01-01T12:00:00Z');
    });
  });

  describe('Chaining', () => {
    test('should support fluent chaining', () => {
      const result = markdown()
        .h1('Title')
        .paragraph('Text')
        .list(['a', 'b'])
        .hr()
        .keyValue('Key', 'Value')
        .build();

      expect(result).toContain('# Title');
      expect(result).toContain('Text');
      expect(result).toContain('- a');
      expect(result).toContain('---');
      expect(result).toContain('**Key:** Value');
    });
  });

  describe('Alert boxes', () => {
    test('should create note alert', () => {
      const result = markdown().alert('note', 'This is a note').build();
      expect(result).toContain('> [!NOTE]');
      expect(result).toContain('> This is a note');
    });

    test('should create tip alert', () => {
      const result = markdown().alert('tip', 'This is a helpful tip').build();
      expect(result).toContain('> [!TIP]');
      expect(result).toContain('> This is a helpful tip');
    });

    test('should create important alert', () => {
      const result = markdown().alert('important', 'This is important').build();
      expect(result).toContain('> [!IMPORTANT]');
      expect(result).toContain('> This is important');
    });

    test('should create warning alert', () => {
      const result = markdown().alert('warning', 'This is a warning').build();
      expect(result).toContain('> [!WARNING]');
      expect(result).toContain('> This is a warning');
    });

    test('should create caution alert', () => {
      const result = markdown().alert('caution', 'This is dangerous').build();
      expect(result).toContain('> [!CAUTION]');
      expect(result).toContain('> This is dangerous');
    });

    test('should handle multi-line alert content', () => {
      const result = markdown().alert('note', 'Line 1\nLine 2\nLine 3').build();
      expect(result).toContain('> [!NOTE]');
      expect(result).toContain('> Line 1');
      expect(result).toContain('> Line 2');
      expect(result).toContain('> Line 3');
    });
  });

  describe('Task lists', () => {
    test('should create task list with mixed states', () => {
      const result = markdown()
        .taskList([
          { checked: true, text: 'Complete setup' },
          { checked: false, text: 'Run tests' },
          { checked: true, text: 'Deploy to production' },
        ])
        .build();

      expect(result).toContain('- [x] Complete setup');
      expect(result).toContain('- [ ] Run tests');
      expect(result).toContain('- [x] Deploy to production');
    });

    test('should handle empty task list', () => {
      const result = markdown().taskList([]).build();
      expect(result).toBe('');
    });

    test('should create single task', () => {
      const result = markdown()
        .taskList([{ checked: false, text: 'Single task' }])
        .build();
      expect(result).toBe('- [ ] Single task');
    });
  });

  describe('Images', () => {
    test('should create image without title', () => {
      const result = markdown().image('Alt text', 'https://example.com/image.png').build();
      expect(result).toBe('![Alt text](https://example.com/image.png)');
    });

    test('should create image with title', () => {
      const result = markdown()
        .image('Alt text', 'https://example.com/image.png', 'Hover title')
        .build();
      expect(result).toBe('![Alt text](https://example.com/image.png "Hover title")');
    });
  });

  describe('Text formatting', () => {
    test('should create strikethrough text', () => {
      const result = markdown().strikethrough('deprecated').build();
      expect(result).toBe('~~deprecated~~');
    });

    test('should create bold text', () => {
      const result = markdown().bold('important').build();
      expect(result).toBe('**important**');
    });

    test('should create italic text', () => {
      const result = markdown().italic('emphasized').build();
      expect(result).toBe('*emphasized*');
    });

    test('should create bold and italic text', () => {
      const result = markdown().boldItalic('very important').build();
      expect(result).toBe('***very important***');
    });

    test('should combine text formatting inline', () => {
      const result = markdown()
        .text('Regular ')
        .bold('bold ')
        .italic('italic ')
        .strikethrough('struck')
        .build();
      expect(result).toBe('Regular **bold ***italic *~~struck~~');
    });
  });

  describe('Diff blocks', () => {
    test('should create diff with additions and deletions', () => {
      const result = markdown()
        .diff({
          additions: ['const newFeature = true;'],
          deletions: ['const oldFeature = false;'],
        })
        .build();

      expect(result).toContain('```diff');
      expect(result).toContain('- const oldFeature = false;');
      expect(result).toContain('+ const newFeature = true;');
    });

    test('should create diff with context lines', () => {
      const result = markdown()
        .diff({
          context: ['// Configuration', 'export const config = {'],
          additions: ['  newOption: true,'],
          deletions: ['  oldOption: false,'],
        })
        .build();

      expect(result).toContain('// Configuration');
      expect(result).toContain('export const config = {');
      expect(result).toContain('+   newOption: true,');
      expect(result).toContain('-   oldOption: false,');
    });

    test('should handle additions only', () => {
      const result = markdown()
        .diff({
          additions: ['new line 1', 'new line 2'],
        })
        .build();

      expect(result).toContain('+ new line 1');
      expect(result).toContain('+ new line 2');
    });

    test('should handle deletions only', () => {
      const result = markdown()
        .diff({
          deletions: ['removed line 1', 'removed line 2'],
        })
        .build();

      expect(result).toContain('- removed line 1');
      expect(result).toContain('- removed line 2');
    });

    test('should handle empty diff', () => {
      const result = markdown().diff({}).build();
      expect(result).toBe('');
    });
  });

  describe('Badges', () => {
    test('should create basic badge', () => {
      const result = markdown().badge('build', 'passing', 'green').build();
      expect(result).toContain('![build: passing]');
      expect(result).toContain('https://img.shields.io/badge/build-passing-green');
    });

    test('should create badge with default color', () => {
      const result = markdown().badge('version', '1.0.0').build();
      expect(result).toContain('![version: 1.0.0]');
      expect(result).toContain('https://img.shields.io/badge/version-1.0.0-blue');
    });

    test('should encode special characters in badge', () => {
      const result = markdown().badge('test coverage', '95%', 'green').build();
      expect(result).toContain('test%20coverage');
      expect(result).toContain('95%25');
    });
  });

  describe('Enhanced examples', () => {
    test('should build PR summary with new features', () => {
      const md = markdown();
      const result = md
        .h1('Pull Request Summary', '🔀')
        .alert('important', 'This PR introduces breaking changes')
        .blankLine()
        .h2('Changes')
        .taskList([
          { checked: true, text: 'Update API endpoints' },
          { checked: true, text: 'Add tests' },
          { checked: false, text: 'Update documentation' },
        ])
        .blankLine()
        .h2('Diff Preview')
        .diff({
          context: ['function oldFunction() {'],
          deletions: ['  return "old";'],
          additions: ['  return "new";'],
        })
        .blankLine()
        .badge('tests', 'passing', 'green')
        .text(' ')
        .badge('coverage', '95%', 'brightgreen')
        .build();

      expect(result).toContain('# 🔀 Pull Request Summary');
      expect(result).toContain('> [!IMPORTANT]');
      expect(result).toContain('- [x] Update API endpoints');
      expect(result).toContain('- [ ] Update documentation');
      expect(result).toContain('```diff');
      expect(result).toContain('![tests: passing]');
      expect(result).toContain('![coverage: 95%]');
    });

    test('should build deployment report', () => {
      const md = markdown();
      const result = md
        .h1('Deployment Report', '🚀')
        .keyValue('Environment', 'Production')
        .keyValue('Version', '2.1.0')
        .keyValue('Timestamp', '2024-01-01T12:00:00Z')
        .blankLine()
        .alert('tip', 'Deployment completed successfully in 3m 45s')
        .blankLine()
        .h2('Services Updated')
        .taskList([
          { checked: true, text: 'API Server' },
          { checked: true, text: 'Web Frontend' },
          { checked: true, text: 'Background Workers' },
        ])
        .build();

      expect(result).toContain('# 🚀 Deployment Report');
      expect(result).toContain('**Environment:** Production');
      expect(result).toContain('> [!TIP]');
      expect(result).toContain('- [x] API Server');
    });
  });
});
