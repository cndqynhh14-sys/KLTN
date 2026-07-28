export function $(id) {
  return document.getElementById(id);
}

export function el(tag, opts) {
  const node = document.createElement(tag);
  if (opts) {
    if (opts.className) node.className = opts.className;
    if (opts.text != null) node.textContent = opts.text;
    if (opts.attrs) Object.keys(opts.attrs).forEach((key) => node.setAttribute(key, opts.attrs[key]));
  }
  if (String(tag).toLowerCase() === 'button' && !node.hasAttribute('type')) node.setAttribute('type', 'button');
  return node;
}
