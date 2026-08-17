import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownPreview } from './App';

describe('MarkdownPreview', () => {
  it('renders common Markdown structures instead of showing the source as one plain-text block', () => {
    const markup = renderToStaticMarkup(<MarkdownPreview content={'# Release notes\n\n- **Fixed** `renderer.ts`\n- [Read docs](https://example.com)\n\n```ts\nconst ready = true;\n```'} />);

    expect(markup).toContain('<h1>Release notes</h1>');
    expect(markup).toContain('<ul>');
    expect(markup).toContain('<strong>Fixed</strong>');
    expect(markup).toContain('<code>renderer.ts</code>');
    expect(markup).toContain('<a href="https://example.com"');
    expect(markup).toContain('<pre data-language="ts"><code>const ready = true;</code></pre>');
  });
});
