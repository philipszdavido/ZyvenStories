const SVG_NS = "http://www.w3.org/2000/svg";

type Shape = [tag: string, attrs: Record<string, string>];

const p = (d: string): Shape => ["path", { d }];
const c = (cx: number, cy: number, r: number): Shape => ["circle", { cx: String(cx), cy: String(cy), r: String(r) }];

const ICONS: Record<string, Shape[]> = {
  plus: [p("M12 5v14M5 12h14")],
  search: [c(11, 11, 6.5), p("m20 20-4.2-4.2")],
  settings: [p("M4 7h8m4 0h4M4 17h4m4 0h8"), c(14, 7, 2), c(10, 17, 2)],
  sidebar: [["rect", { x: "3.5", y: "4.5", width: "17", height: "15", rx: "3" }], p("M9.5 4.5v15")],
  more: [c(6, 12, 1.2), c(12, 12, 1.2), c(18, 12, 1.2)],
  compose: [p("M12 20h8"), p("M15.8 4.2a2 2 0 0 1 2.9 2.9L8 17.8l-4 1 1-4Z")],
  "arrow-up": [p("M12 19V5M5.5 11.5 12 5l6.5 6.5")],
  "arrow-down": [p("M12 5v14M5.5 12.5 12 19l6.5-6.5")],
  stop: [["rect", { x: "7", y: "7", width: "10", height: "10", rx: "2", class: "fill" }]],
  chevron: [p("m7 10 5 5 5-5")],
  alert: [c(12, 12, 8.5), p("M12 8v4.5M12 15.8v.2")],
  close: [p("M6.5 6.5l11 11M17.5 6.5l-11 11")],
  copy: [["rect", { x: "9", y: "9", width: "11", height: "11", rx: "2.5" }], p("M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h8.5A1.5 1.5 0 0 1 15 5v.5")],
  check: [p("m5 12.5 4.5 4.5L19 7.5")],
  retry: [p("M19.5 12a7.5 7.5 0 1 1-2.2-5.3"), p("M19.5 4.5v4h-4")],
  edit: [p("M15.8 4.2a2 2 0 0 1 2.9 2.9L8 17.8l-4 1 1-4Z")],
  trash: [p("M4.5 7h15M10 11v6M14 11v6M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.5h6.4a1.5 1.5 0 0 0 1.5-1.5l.8-12M9.5 7V4.5h5V7")],
  mail: [["rect", { x: "3.5", y: "5.5", width: "17", height: "13", rx: "2.5" }], p("m4.5 7.5 7.5 5.5 7.5-5.5")],
  external: [p("M14 4.5h5.5V10M19.5 4.5 11 13"), p("M18 14v4a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V7.5A1.5 1.5 0 0 1 6 6h4")],
  info: [c(12, 12, 8.5), p("M12 11v5M12 8v.2")],
};

export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("icon", `icon-${name}`);

  if (name === "mark") {
    const rect = document.createElementNS(SVG_NS, "rect");
    for (const [k, v] of Object.entries({ x: "2", y: "2", width: "20", height: "20", rx: "6", class: "mark-bg" })) rect.setAttribute(k, v);
    const z = document.createElementNS(SVG_NS, "path");
    z.setAttribute("d", "M8 8.2h8l-8 7.6h8");
    z.setAttribute("class", "mark-fg");
    svg.append(rect, z);
    return svg;
  }

  for (const [tag, attrs] of ICONS[name] ?? []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.appendChild(node);
  }
  return svg;
}

export function hydrateIcons(root: ParentNode = document): void {
  for (const host of root.querySelectorAll<HTMLElement>("[data-icon]")) {
    if (host.querySelector(":scope > svg.icon")) continue;
    host.prepend(icon(host.dataset.icon!));
  }
}
