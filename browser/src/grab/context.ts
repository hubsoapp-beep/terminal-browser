export interface ElementContext {
  selector: string;
  label: string;
  block: string;
}

// Runs in the page, so everything it needs lives inside it: no imports, no module constants.
export function elementContext(element: Element): ElementContext {
  const textLimit = 200;
  const htmlLimit = 600;
  const ancestorLimit = 6;
  const styleNames = [
    "display",
    "position",
    "font-size",
    "font-weight",
    "line-height",
    "color",
    "background-color",
    "margin",
    "padding",
    "border",
    "border-radius",
    "gap",
  ];
  const unsafeCharacters = /[^a-zA-Z0-9_-]/g;
  const escape = (value: string): string => value.replace(unsafeCharacters, (character) => `\\${character}`);
  const clip = (value: string, limit: number): string =>
    value.length > limit ? `${value.slice(0, limit)}…` : value;

  const uniqueSelector = (): string => {
    if (element.id) {
      const id = `#${escape(element.id)}`;
      if (element.ownerDocument.querySelectorAll(id).length === 1) return id;
    }
    const segments: string[] = [];
    for (let current: Element | null = element; current && current !== element.ownerDocument.documentElement; ) {
      let segment = current.tagName.toLowerCase();
      if (current.id) {
        segment += `#${escape(current.id)}`;
      } else {
        const classes = Array.from(current.classList).slice(0, 3);
        if (classes.length > 0) segment += classes.map((name) => `.${escape(name)}`).join("");
      }
      const parent: Element | null = current.parentElement;
      if (parent) {
        const self = current;
        const siblings = Array.from(parent.children).filter((child) => child.tagName === self.tagName);
        if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(self) + 1})`;
      }
      segments.unshift(segment);
      const candidate = segments.join(" > ");
      if (element.ownerDocument.querySelectorAll(candidate).length === 1) return candidate;
      current = parent;
    }
    return segments.join(" > ");
  };

  const path = (detail: (node: Element) => string, includeElement: boolean): string => {
    const nodes: Element[] = [];
    for (let current: Element | null = includeElement ? element : element.parentElement; current; current = current.parentElement) {
      if (current !== element.ownerDocument.documentElement) nodes.unshift(current);
    }
    const shown =
      nodes.length <= ancestorLimit
        ? nodes
        : [...nodes.slice(0, 2), null, ...nodes.slice(-(ancestorLimit - 3))];
    return shown
      .map((node) => (node ? detail(node) : "…"))
      .join(" > ");
  };

  const selector = uniqueSelector();
  const box = element.getBoundingClientRect();
  const dimensions = `${Math.round(box.width)}×${Math.round(box.height)}`;
  const style = getComputedStyle(element);
  const text = clip(
    (
      element.textContent ||
      element.getAttribute("alt") ||
      element.getAttribute("placeholder") ||
      (element as HTMLInputElement).value ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim(),
    textLimit,
  );
  const block = [
    `Selected element: ${element.tagName.toLowerCase()}`,
    `Role: ${element.getAttribute("role") || element.tagName.toLowerCase()}`,
    `Selector: ${selector}`,
    `Dimensions: ${dimensions}`,
    text ? `Text: ${text}` : "",
    `Styles: ${styleNames.map((name) => `${name}: ${style.getPropertyValue(name) || "auto"}`).join("; ")}`,
    `HTML: ${clip(element.outerHTML.replace(/\s+/g, " ").trim(), htmlLimit)}`,
    `Ancestors: ${path((node) => node.tagName.toLowerCase(), false)}`,
    `DOM path: ${path(
      (node) =>
        node.tagName.toLowerCase() +
        (node.id ? `#${escape(node.id)}` : "") +
        Array.from(node.classList)
          .slice(0, 2)
          .map((name) => `.${escape(name)}`)
          .join(""),
      true,
    )}`,
    `URL: ${element.ownerDocument.location?.href ?? ""}`,
  ]
    .filter(Boolean)
    .join("\n");

  return { selector, label: `${selector}  ${dimensions}`, block };
}

export interface GrabPluginOptions {
  channel: string;
  plugin: string;
  binding: string;
  regionPadding: number;
}

export function grabPlugin({ channel, plugin, binding, regionPadding }: GrabPluginOptions): string {
  return `(api) => {
  const emit = (data) => window.${binding}?.(JSON.stringify({ channel: ${JSON.stringify(channel)}, data }));
  const context = (${elementContext.toString()});
  const probe = () => {
    const existing = document.getElementById("terminal-browser-probe");
    if (existing) return existing;
    const node = document.createElement("div");
    node.id = "terminal-browser-probe";
    node.setAttribute("data-react-grab-ignore", "");
    Object.assign(node.style, {
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      display: "none",
      padding: "2px 6px",
      borderRadius: "4px",
      background: "#111",
      color: "#f4f4f5",
      font: "11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
      whiteSpace: "nowrap",
      boxShadow: "0 2px 8px rgba(0, 0, 0, 0.45)",
    });
    document.documentElement.appendChild(node);
    return node;
  };
  let hovered = null;
  let hoveredLabel = "";
  const hideProbe = () => {
    hovered = null;
    const node = document.getElementById("terminal-browser-probe");
    if (node) node.style.display = "none";
  };
  const regionAround = (elements) => {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const element of elements) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      left = Math.min(left, box.left);
      top = Math.min(top, box.top);
      right = Math.max(right, box.right);
      bottom = Math.max(bottom, box.bottom);
    }
    if (!Number.isFinite(left)) return null;
    const x = Math.max(0, left - ${regionPadding});
    const y = Math.max(0, top - ${regionPadding});
    const x2 = Math.min(window.innerWidth, right + ${regionPadding});
    const y2 = Math.min(window.innerHeight, bottom + ${regionPadding});
    return x2 - x >= 1 && y2 - y >= 1 ? { x, y, width: x2 - x, height: y2 - y } : null;
  };
  const overlay = document.querySelector("[data-react-grab]")?.shadowRoot;
  if (overlay && !overlay.querySelector("#${plugin}-style")) {
    const style = document.createElement("style");
    style.id = "${plugin}-style";
    style.textContent = "[data-react-grab-completion] { display: none !important; }";
    overlay.appendChild(style);
  }
  if (api.getPlugins().includes(${JSON.stringify(plugin)})) return;
  api.registerPlugin({
    name: ${JSON.stringify(plugin)},
    theme: { toolbar: { enabled: false } },
    hooks: {
      onActivate: () => emit({ type: "active", active: true }),
      onDeactivate: () => {
        hideProbe();
        emit({ type: "active", active: false });
      },
      onSelectionBox: (visible, bounds, element) => {
        if (!visible || !bounds || !element) {
          hideProbe();
          return;
        }
        const node = probe();
        if (element !== hovered) {
          hovered = element;
          hoveredLabel = context(element).label;
        }
        node.textContent = hoveredLabel;
        node.style.display = "block";
        node.style.left = Math.max(0, Math.min(bounds.x, window.innerWidth - node.offsetWidth - 4)) + "px";
        node.style.top =
          (bounds.y < node.offsetHeight + 8 ? bounds.y + bounds.height + 6 : bounds.y - node.offsetHeight - 6) + "px";
      },
      transformCopyContent: (content, elements) => {
        const target = elements[0];
        const described = target ? context(target) : null;
        hideProbe();
        emit({
          type: "selected",
          content: described ? described.block + "\\n\\n" + content : content,
          region: regionAround(elements),
        });
        api.reset();
        api.deactivate();
        return content;
      },
    },
  });
}`;
}
