import cssText from './styles.css?raw';

const STYLE_ATTRIBUTE = 'data-spatial-trajectory-style';

/** Install the shared stylesheet for both Vite standalone mode and the Harness module loader. */
export function ensureSpatialStyles(): void {
  if (typeof document === 'undefined' || document.querySelector(`style[${STYLE_ATTRIBUTE}]`)) return;
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTRIBUTE, '');
  style.textContent = cssText;
  document.head.append(style);
}
