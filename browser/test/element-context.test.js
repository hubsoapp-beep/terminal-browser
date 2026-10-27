const assert = require("node:assert/strict");
const { test } = require("node:test");

const { elementContext, grabPlugin } = require("../dist/grab/context.js");

const parseSegment = (segment) => {
  const nth = segment.match(/:nth-of-type\((\d+)\)$/);
  const base = nth ? segment.slice(0, nth.index) : segment;
  const id = base.match(/#([^.#]+)/);
  return {
    tag: base.split(/[#.:]/)[0] || null,
    id: id ? id[1] : null,
    classes: [...base.matchAll(/\.([^.#]+)/g)].map((match) => match[1]),
    nth: nth ? Number(nth[1]) : null,
  };
};

const matchesSegment = (node, segment) => {
  if (segment.tag && node.tagName.toLowerCase() !== segment.tag) return false;
  if (segment.id && node.id !== segment.id) return false;
  if (!segment.classes.every((name) => node.classList.includes(name))) return false;
  if (segment.nth != null) {
    const siblings = node.parentElement.children.filter((child) => child.tagName === node.tagName);
    if (siblings.indexOf(node) + 1 !== segment.nth) return false;
  }
  return true;
};

const matchesPath = (node, segments) => {
  if (segments.length === 0) return true;
  if (!matchesSegment(node, segments[segments.length - 1])) return false;
  return node.parentElement != null && matchesPath(node.parentElement, segments.slice(0, -1));
};

const document = {
  documentElement: null,
  location: { href: "https://example.test/" },
  querySelectorAll(selector) {
    const segments = selector.split(" > ").map(parseSegment);
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matchesPath(child, segments)) found.push(child);
        walk(child);
      }
    };
    walk(document.documentElement);
    return found;
  },
};

const element = (tagName, { id = "", classes = [], text = "", children = [], attributes = {} } = {}) => {
  const node = {
    tagName: tagName.toUpperCase(),
    id,
    classList: classes,
    children: [],
    parentElement: null,
    ownerDocument: document,
    textContent: text,
    outerHTML: text ? `<${tagName}>${text}</${tagName}>` : `<${tagName}></${tagName}>`,
    getAttribute: (name) => (name in attributes ? attributes[name] : null),
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 420, height: 34 }),
  };
  for (const child of children) {
    child.parentElement = node;
    node.children.push(child);
  }
  return node;
};

const page = (body) => {
  document.documentElement = element("html", { children: [body] });
  body.parentElement = document.documentElement;
  return body;
};

globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => (name === "display" ? "flow-root" : "") });

test("an element with a unique id is identified by that id alone", () => {
  const target = element("h2", { id: "hero-title", text: "Hår som passer deg" });
  page(element("body", { children: [target] }));

  assert.equal(elementContext(target).selector, "#hero-title");
});

test("a class-only path falls back to the nearest parent that makes it unique", () => {
  const target = element("h2", { classes: ["title"], text: "Hår som passer deg" });
  const other = element("h2", { classes: ["title"], text: "other card" });
  page(
    element("body", {
      children: [
        element("div", { classes: ["card"], children: [target] }),
        element("div", { classes: ["card"], children: [other] }),
      ],
    }),
  );

  const { selector } = elementContext(target);
  assert.equal(selector, "div.card:nth-of-type(1) > h2.title");
  assert.equal(document.querySelectorAll(selector).length, 1);
});

test("repeated siblings get an nth-of-type so the selector stays unique", () => {
  const target = element("h2", { classes: ["title"], text: "second" });
  page(
    element("body", {
      children: [element("div", { classes: ["grid"], children: [element("h2", { classes: ["title"] }), target] })],
    }),
  );

  const { selector } = elementContext(target);
  assert.match(selector, /:nth-of-type\(2\)$/);
  assert.equal(document.querySelectorAll(selector).length, 1);
});

test("the block carries the fields an agent needs to find the element again", () => {
  const target = element("h2", {
    classes: ["pbmit-element-title"],
    text: "  Hår\n som   passer deg ",
    attributes: { role: "heading" },
  });
  page(element("body", { children: [element("section", { children: [target] })] }));

  const { block, label } = elementContext(target);

  assert.match(block, /^Selected element: h2$/m);
  assert.match(block, /^Role: heading$/m);
  assert.match(block, /^Selector: h2\.pbmit-element-title$/m);
  assert.match(block, /^Dimensions: 420×34$/m);
  assert.match(block, /^Text: Hår som passer deg$/m);
  assert.match(block, /^Styles: display: flow-root;/m);
  assert.match(block, /^HTML: <h2>/m);
  assert.match(block, /^Ancestors: body > section$/m);
  assert.match(block, /^DOM path: body > section > h2\.pbmit-element-title$/m);
  assert.match(block, /^URL: https:\/\/example\.test\/$/m);
  assert.equal(label, "h2.pbmit-element-title  420×34");
});

test("a deep ancestor chain is elided instead of flooded into the message", () => {
  let node = element("h2", { classes: ["title"], text: "deep" });
  for (let depth = 0; depth < 9; depth += 1) node = element("div", { children: [node] });
  page(element("body", { children: [node] }));

  const ancestors = elementContext(node.children[0].children[0].children[0].children[0].children[0].children[0].children[0].children[0].children[0]).block.match(/^Ancestors: (.*)$/m)[1];
  const parts = ancestors.split(" > ");

  assert.ok(parts.includes("…"));
  assert.equal(parts.length, 6);
});

test("the plugin handed to the page parses and wires the selection hooks", () => {
  const source = grabPlugin({ channel: "grab", plugin: "terminal-browser", binding: "__pixelEmit", regionPadding: 8 });
  globalThis.document = {
    querySelector: () => null,
    getElementById: () => null,
    documentElement: { appendChild() {} },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  };

  const register = new Function(`return ${source}`)();
  const registered = [];
  register({ getPlugins: () => [], registerPlugin: (plugin) => registered.push(plugin), reset() {}, deactivate() {} });

  const hooks = registered[0].hooks;
  assert.equal(registered[0].name, "terminal-browser");
  assert.deepEqual(Object.keys(hooks).sort(), ["onActivate", "onDeactivate", "onSelectionBox", "transformCopyContent"]);
});
