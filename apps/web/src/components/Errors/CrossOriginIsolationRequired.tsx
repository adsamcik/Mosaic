export const CROSS_ORIGIN_ISOLATION_DOCS_URL =
  'https://developer.mozilla.org/en-US/docs/Web/Security/Cross-Origin-Resource-Policy/Cross-Origin-Embedder-Policy';

const title = 'Browser upgrade required';
const message =
  "Your browser doesn't support cross-origin isolation, which Mosaic requires for client-side encryption.";
const details =
  'Mosaic needs Safari 17.4+ (released 2024-03), Chrome 102+, Firefox 111+, or Edge 102+ so SharedArrayBuffer, WebAssembly, and encrypted local storage can initialize safely.';
const help =
  'If you are already using a supported browser, ask your administrator to verify that Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers are present.';
const buttonText = 'Open documentation';

function applyStyles(
  element: HTMLElement,
  styles: Partial<CSSStyleDeclaration>,
): void {
  Object.assign(element.style, styles);
}

function appendTextElement(
  parent: HTMLElement,
  tagName: keyof HTMLElementTagNameMap,
  text: string,
  styles: Partial<CSSStyleDeclaration>,
): HTMLElement {
  const element = document.createElement(tagName);
  element.textContent = text;
  applyStyles(element, styles);
  parent.append(element);
  return element;
}

export function renderStandalone(root: HTMLElement): void {
  root.replaceChildren();

  const page = document.createElement('main');
  page.setAttribute('role', 'main');
  page.setAttribute('aria-labelledby', 'cross-origin-isolation-title');
  applyStyles(page, {
    minHeight: '100vh',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2rem',
    background: 'var(--color-bg-base, #0f172a)',
    color: 'var(--color-text, #f8fafc)',
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  });

  const card = document.createElement('section');
  applyStyles(card, {
    width: 'min(100%, 42rem)',
    boxSizing: 'border-box',
    padding: '2rem',
    border: '1px solid var(--color-border, rgba(148, 163, 184, 0.35))',
    borderRadius: '1rem',
    background: 'var(--color-bg-surface, rgba(15, 23, 42, 0.92))',
    boxShadow: '0 24px 80px rgba(0, 0, 0, 0.35)',
  });

  const eyebrow = appendTextElement(card, 'p', 'Mosaic cannot start', {
    margin: '0 0 0.75rem',
    color: 'var(--color-text-muted, #94a3b8)',
    fontSize: '0.875rem',
    fontWeight: '700',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  });
  eyebrow.setAttribute('aria-hidden', 'true');

  const heading = appendTextElement(card, 'h1', title, {
    margin: '0 0 1rem',
    fontSize: 'clamp(2rem, 6vw, 3rem)',
    lineHeight: '1.05',
  });
  heading.id = 'cross-origin-isolation-title';

  appendTextElement(card, 'p', message, {
    margin: '0 0 1rem',
    fontSize: '1.125rem',
    lineHeight: '1.65',
  });

  appendTextElement(card, 'p', details, {
    margin: '0 0 1rem',
    color: 'var(--color-text-muted, #cbd5e1)',
    fontSize: '1rem',
    lineHeight: '1.6',
  });

  appendTextElement(card, 'p', help, {
    margin: '0 0 1.5rem',
    color: 'var(--color-text-muted, #cbd5e1)',
    fontSize: '1rem',
    lineHeight: '1.6',
  });

  const link = document.createElement('a');
  link.href = CROSS_ORIGIN_ISOLATION_DOCS_URL;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = buttonText;
  applyStyles(link, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '2.75rem',
    padding: '0 1.25rem',
    borderRadius: '999px',
    background: 'var(--color-accent, #38bdf8)',
    color: 'var(--color-accent-contrast, #082f49)',
    fontWeight: '700',
    textDecoration: 'none',
  });
  card.append(link);

  page.append(card);
  root.append(page);
}
