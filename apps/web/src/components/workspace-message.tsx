"use client";

import { Check, Copy } from "lucide-react";
import { createElement, useId, useState, type ReactNode } from "react";

import {
  parseMermaidFlowchart,
  type FlowchartNode,
  type MermaidFlowchart,
} from "@/lib/workspace-mermaid";

import styles from "./workspace-message.module.css";

type MathTag =
  | "mi"
  | "mn"
  | "mo"
  | "mtext"
  | "mrow"
  | "mfrac"
  | "msqrt"
  | "mroot"
  | "msub"
  | "msup"
  | "msubsup"
  | "mspace";

interface MathNode {
  tag: MathTag;
  text?: string;
  children?: MathNode[];
  attributes?: Record<string, string>;
}

function mathNode(
  tag: MathTag,
  children: MathNode[] = [],
  text?: string,
  attributes?: Record<string, string>,
): MathNode {
  return {
    tag,
    children,
    ...(text === undefined ? {} : { text }),
    ...(attributes ? { attributes } : {}),
  };
}

const mathCommands: Record<string, { value: string; tag: "mi" | "mo" }> = {
  alpha: { value: "α", tag: "mi" },
  beta: { value: "β", tag: "mi" },
  gamma: { value: "γ", tag: "mi" },
  delta: { value: "δ", tag: "mi" },
  epsilon: { value: "ε", tag: "mi" },
  theta: { value: "θ", tag: "mi" },
  lambda: { value: "λ", tag: "mi" },
  mu: { value: "μ", tag: "mi" },
  pi: { value: "π", tag: "mi" },
  sigma: { value: "σ", tag: "mi" },
  phi: { value: "φ", tag: "mi" },
  omega: { value: "ω", tag: "mi" },
  Gamma: { value: "Γ", tag: "mi" },
  Delta: { value: "Δ", tag: "mi" },
  Theta: { value: "Θ", tag: "mi" },
  Lambda: { value: "Λ", tag: "mi" },
  Pi: { value: "Π", tag: "mi" },
  Sigma: { value: "Σ", tag: "mi" },
  Omega: { value: "Ω", tag: "mi" },
  times: { value: "×", tag: "mo" },
  cdot: { value: "·", tag: "mo" },
  div: { value: "÷", tag: "mo" },
  pm: { value: "±", tag: "mo" },
  le: { value: "≤", tag: "mo" },
  leq: { value: "≤", tag: "mo" },
  ge: { value: "≥", tag: "mo" },
  geq: { value: "≥", tag: "mo" },
  neq: { value: "≠", tag: "mo" },
  ne: { value: "≠", tag: "mo" },
  approx: { value: "≈", tag: "mo" },
  infty: { value: "∞", tag: "mi" },
  partial: { value: "∂", tag: "mi" },
  nabla: { value: "∇", tag: "mi" },
  to: { value: "→", tag: "mo" },
  rightarrow: { value: "→", tag: "mo" },
  leftarrow: { value: "←", tag: "mo" },
  Rightarrow: { value: "⇒", tag: "mo" },
  forall: { value: "∀", tag: "mo" },
  exists: { value: "∃", tag: "mo" },
  in: { value: "∈", tag: "mo" },
  notin: { value: "∉", tag: "mo" },
  subset: { value: "⊂", tag: "mo" },
  subseteq: { value: "⊆", tag: "mo" },
  cup: { value: "∪", tag: "mo" },
  cap: { value: "∩", tag: "mo" },
  sum: { value: "∑", tag: "mo" },
  prod: { value: "∏", tag: "mo" },
  int: { value: "∫", tag: "mo" },
};

function readRawGroup(source: string, cursor: { value: number }): string {
  while (/\s/u.test(source[cursor.value] ?? "")) cursor.value += 1;
  if (source[cursor.value] !== "{") return source[cursor.value++] ?? "";
  cursor.value += 1;
  let depth = 1;
  const start = cursor.value;
  while (cursor.value < source.length && depth > 0) {
    const char = source[cursor.value];
    if (char === "\\") {
      cursor.value += 2;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    cursor.value += 1;
  }
  return source.slice(start, Math.max(start, cursor.value - 1));
}

function plainTextMath(value: string): string {
  return value.replace(/\\([{}%$#&_])/gu, "$1").replace(/\\ /gu, " ");
}

function parseLatex(expression: string): MathNode[] {
  const source = expression.replace(
    /\\(?:left|right|displaystyle|textstyle)(?![A-Za-z])/gu,
    "",
  );
  const cursor = { value: 0 };

  function parseArgument(): MathNode[] {
    while (/\s/u.test(source[cursor.value] ?? "")) cursor.value += 1;
    if (source[cursor.value] === "{") {
      cursor.value += 1;
      const children = parseSequence(true);
      if (source[cursor.value] === "}") cursor.value += 1;
      return children;
    }
    return parseSequence(false, true);
  }

  function parseCommand(): MathNode | null {
    cursor.value += 1;
    const commandStart = cursor.value;
    while (/[A-Za-z]/u.test(source[cursor.value] ?? "")) cursor.value += 1;
    if (commandStart === cursor.value) {
      const escaped = source[cursor.value] ?? "";
      cursor.value += 1;
      if (escaped === "," || escaped === ";" || escaped === ":")
        return mathNode("mspace", [], undefined, { width: "0.25em" });
      return escaped ? mathNode("mo", [], escaped) : null;
    }

    const command = source.slice(commandStart, cursor.value);
    if (
      command === "frac" ||
      command === "dfrac" ||
      command === "tfrac" ||
      command === "binom"
    ) {
      const numerator = parseArgument();
      const denominator = parseArgument();
      const fraction = mathNode(
        "mfrac",
        [mathNode("mrow", numerator), mathNode("mrow", denominator)],
        undefined,
        command === "binom" ? { linethickness: "0" } : undefined,
      );
      return command === "binom"
        ? mathNode("mrow", [
            mathNode("mo", [], "("),
            fraction,
            mathNode("mo", [], ")"),
          ])
        : fraction;
    }
    if (command === "sqrt") {
      while (/\s/u.test(source[cursor.value] ?? "")) cursor.value += 1;
      if (source[cursor.value] === "[") {
        cursor.value += 1;
        const indexStart = cursor.value;
        while (cursor.value < source.length && source[cursor.value] !== "]")
          cursor.value += 1;
        const index = parseLatex(source.slice(indexStart, cursor.value));
        if (source[cursor.value] === "]") cursor.value += 1;
        return mathNode("mroot", [
          mathNode("mrow", parseArgument()),
          mathNode("mrow", index),
        ]);
      }
      return mathNode("msqrt", [mathNode("mrow", parseArgument())]);
    }
    if (
      command === "text" ||
      command === "mathrm" ||
      command === "mathbf" ||
      command === "mathit" ||
      command === "operatorname"
    ) {
      return mathNode("mtext", [], plainTextMath(readRawGroup(source, cursor)));
    }
    if (command === "quad" || command === "qquad")
      return mathNode("mspace", [], undefined, {
        width: command === "quad" ? "1em" : "2em",
      });
    const symbol = mathCommands[command];
    if (symbol) return mathNode(symbol.tag, [], symbol.value);
    return mathNode("mtext", [], `\\${command}`);
  }

  function parseAtom(): MathNode | null {
    const char = source[cursor.value];
    if (char === "\\") return parseCommand();
    if (char === "{") {
      cursor.value += 1;
      const children = parseSequence(true);
      if (source[cursor.value] === "}") cursor.value += 1;
      return mathNode("mrow", children);
    }
    if (char === " ") {
      while (source[cursor.value] === " ") cursor.value += 1;
      return mathNode("mspace", [], undefined, { width: "0.25em" });
    }
    if (char === undefined) return null;
    cursor.value += 1;
    if (/\d/u.test(char)) return mathNode("mn", [], char);
    if (/[A-Za-z]/u.test(char)) return mathNode("mi", [], char);
    return mathNode("mo", [], char);
  }

  function parseSequence(stopAtBrace: boolean, oneAtom = false): MathNode[] {
    const nodes: MathNode[] = [];
    while (cursor.value < source.length) {
      const char = source[cursor.value];
      if (char === "}" && stopAtBrace) break;
      if (char === "_" || char === "^") {
        cursor.value += 1;
        const script = mathNode("mrow", parseArgument());
        const base = nodes.pop() ?? mathNode("mtext", [], "_");
        const hasSub = base.tag === "msub" || base.tag === "msubsup";
        const hasSup = base.tag === "msup" || base.tag === "msubsup";
        const baseChild =
          base.tag === "msub" || base.tag === "msup" || base.tag === "msubsup"
            ? (base.children?.[0] ?? base)
            : base;
        const subChild =
          base.tag === "msub" || base.tag === "msubsup"
            ? base.children?.[1]
            : undefined;
        const supChild =
          base.tag === "msup"
            ? base.children?.[1]
            : base.tag === "msubsup"
              ? base.children?.[2]
              : undefined;
        if (char === "_" && hasSup)
          nodes.push(
            mathNode("msubsup", [baseChild, script, supChild ?? script]),
          );
        else if (char === "^" && hasSub)
          nodes.push(
            mathNode("msubsup", [baseChild, subChild ?? script, script]),
          );
        else if (char === "_") nodes.push(mathNode("msub", [base, script]));
        else nodes.push(mathNode("msup", [base, script]));
      } else {
        const node = parseAtom();
        if (node) nodes.push(node);
      }
      if (oneAtom && nodes.length) break;
    }
    return nodes;
  }

  return parseSequence(false);
}

function renderMathNode(node: MathNode, key: string): ReactNode {
  const children =
    node.text ??
    node.children?.map((child, index) =>
      renderMathNode(child, `${key}-${index}`),
    );
  return createElement(node.tag, { key, ...node.attributes }, children);
}

function MathExpression({
  expression,
  display = false,
}: {
  expression: string;
  display?: boolean;
}) {
  const className = display ? styles.displayMath : styles.inlineMath;
  return (
    <span className={className}>
      {createElement(
        "math",
        {
          xmlns: "http://www.w3.org/1998/Math/MathML",
          display: display ? "block" : "inline",
          role: "math",
          "aria-label": expression,
        },
        ...parseLatex(expression).map((node, index) =>
          renderMathNode(node, `math-${index}`),
        ),
      )}
    </span>
  );
}

function safeHref(value: string): string | null {
  const candidate = value.trim();
  if (/^(?:https?:\/\/|mailto:)/iu.test(candidate)) return candidate;
  if (/^\/(?!\/)/u.test(candidate)) return candidate;
  return null;
}

const inlinePattern =
  /(`[^`]+`|\\\([\s\S]+?\\\)|\$\$[^$\n]+\$\$|\$[^$\n]+\$|\[[^\]]+\]\([^\s)]+\)|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|(?<!\*)\*[^*]+\*(?!\*)|(?<!_)_[^_]+_(?!_))/gu;

function renderInline(value: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let tokenIndex = 0;
  while ((match = inlinePattern.exec(value)) !== null) {
    if (match.index > cursor) nodes.push(value.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${tokenIndex++}`;
    if (token.startsWith("`")) {
      nodes.push(
        <code className={styles.inlineCode} key={key}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("\\(") && token.endsWith("\\)")) {
      nodes.push(<MathExpression key={key} expression={token.slice(2, -2)} />);
    } else if (token.startsWith("$$") && token.endsWith("$$")) {
      nodes.push(
        <MathExpression key={key} display expression={token.slice(2, -2)} />,
      );
    } else if (token.startsWith("$") && token.endsWith("$")) {
      nodes.push(<MathExpression key={key} expression={token.slice(1, -1)} />);
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token);
      const href = link ? safeHref(link[2] ?? "") : null;
      if (!link || !href) {
        nodes.push(token);
      } else {
        const external = /^https?:/iu.test(href);
        nodes.push(
          <a
            key={key}
            href={href}
            {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
          >
            {renderInline(link[1] ?? "", `${key}-label`)}
          </a>,
        );
      }
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(
        <strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>,
      );
    } else if (token.startsWith("~~")) {
      nodes.push(<del key={key}>{renderInline(token.slice(2, -2), key)}</del>);
    } else {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    }
    cursor = match.index + token.length;
  }
  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes;
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const diagram =
    language.toLowerCase() === "mermaid" ? parseMermaidFlowchart(code) : null;

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 2200);
    }
  }

  const label = /^[A-Za-z0-9_+#.-]{1,24}$/u.test(language) ? language : "kode";
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHeader}>
        <span>{label}</span>
        <button
          type="button"
          onClick={() => void copyCode()}
          aria-label={`Salin ${label}`}
          title={copyState === "copied" ? "Kode tersalin" : "Salin kode"}
        >
          {copyState === "copied" ? (
            <Check aria-hidden="true" size={14} />
          ) : (
            <Copy aria-hidden="true" size={14} />
          )}
          {copyState === "copied"
            ? "Tersalin"
            : copyState === "failed"
              ? "Gagal"
              : "Salin"}
        </button>
      </div>
      {language.toLowerCase() === "mermaid" ? (
        diagram ? (
          <MermaidDiagram diagram={diagram} />
        ) : (
          <div className={styles.diagramFallback} role="status">
            Pratinjau hanya tersedia untuk diagram alur sederhana. Sintaks tetap
            bisa disalin di atas.
            <pre>
              <code>{code}</code>
            </pre>
          </div>
        )
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

function wrapDiagramLabel(label: string): string[] {
  const words = label.split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && `${line} ${word}`.length > 22) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines.slice(0, 4) : [label];
}

function diagramNodeShape(node: FlowchartNode) {
  if (node.shape === "decision") {
    const halfWidth = 96;
    const halfHeight = 36;
    const centerX = node.x + 92;
    const centerY = node.y + 29;
    return (
      <polygon
        className={styles.diagramNodeShape}
        points={`${centerX},${centerY - halfHeight} ${centerX + halfWidth},${centerY} ${centerX},${centerY + halfHeight} ${centerX - halfWidth},${centerY}`}
      />
    );
  }
  return (
    <rect
      className={styles.diagramNodeShape}
      x={node.x}
      y={node.y}
      width={184}
      height={58}
      rx={node.shape === "rounded" ? 29 : 9}
    />
  );
}

function MermaidDiagram({ diagram }: { diagram: MermaidFlowchart }) {
  const markerId = `arrow-${useId().replace(/:/gu, "")}`;
  const nodesById = new Map(diagram.nodes.map((node) => [node.id, node]));
  return (
    <div className={styles.diagramScroll}>
      <svg
        className={styles.diagram}
        role="img"
        aria-label="Pratinjau diagram alur"
        viewBox={`0 0 ${diagram.width} ${diagram.height}`}
        width={diagram.width}
        height={diagram.height}
      >
        <title>Pratinjau diagram alur</title>
        <defs>
          <marker
            id={markerId}
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path className={styles.diagramArrow} d="M0,0 L8,4 L0,8 z" />
          </marker>
        </defs>
        {diagram.edges.map((edge, index) => {
          const from = nodesById.get(edge.from);
          const to = nodesById.get(edge.to);
          if (!from || !to) return null;
          const startX = from.x + 92;
          const startY = from.y + 29;
          const endX = to.x + 92;
          const endY = to.y + 29;
          const path =
            diagram.direction === "TB"
              ? `M ${startX} ${startY + 29} C ${startX} ${(startY + endY) / 2}, ${endX} ${(startY + endY) / 2}, ${endX} ${endY - 29}`
              : `M ${startX + 92} ${startY} C ${(startX + endX) / 2} ${startY}, ${(startX + endX) / 2} ${endY}, ${endX - 92} ${endY}`;
          return (
            <g key={`edge-${index}`}>
              <path
                className={styles.diagramEdge}
                d={path}
                markerEnd={`url(#${markerId})`}
              />
              {edge.label ? (
                <text
                  className={styles.diagramEdgeLabel}
                  x={(startX + endX) / 2}
                  y={(startY + endY) / 2 - 5}
                  textAnchor="middle"
                >
                  {edge.label}
                </text>
              ) : null}
            </g>
          );
        })}
        {diagram.nodes.map((node) => {
          const lines = wrapDiagramLabel(node.label);
          const firstLineY = node.y + 29 - ((lines.length - 1) * 15) / 2 + 5;
          return (
            <g key={node.id}>
              {diagramNodeShape(node)}
              <text
                className={styles.diagramNodeLabel}
                x={node.x + 92}
                y={firstLineY}
                textAnchor="middle"
              >
                {lines.map((line, index) => (
                  <tspan
                    key={`${node.id}-${index}`}
                    x={node.x + 92}
                    dy={index ? 15 : 0}
                  >
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function isBullet(line: string): boolean {
  return /^\s*[-*+]\s+/u.test(line);
}

function isNumbered(line: string): boolean {
  return /^\s*\d+[.)]\s+/u.test(line);
}

function isHeading(line: string): boolean {
  return /^\s{0,3}#{1,6}\s/u.test(line);
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return (
    /^\s*```/u.test(line) ||
    isHeading(line) ||
    /^\s*>/u.test(line) ||
    isBullet(line) ||
    isNumbered(line) ||
    /^\s*(?:\*\s*){3,}$|^\s*(?:-\s*){3,}$|^\s*(?:_\s*){3,}$/u.test(line) ||
    /^\s*\$\$/u.test(line) ||
    /^\s*\\\[/u.test(line) ||
    (index + 1 < lines.length &&
      line.includes("|") &&
      /^\s*\|?\s*:?-{3,}/u.test(lines[index + 1] ?? ""))
  );
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/gu, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function WorkspaceMessage({
  content,
  className,
}: {
  content: string;
  className?: string | undefined;
}) {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let blockKey = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^\s*```\s*([^\s`]*)\s*$/u.exec(line);
    if (fence) {
      const codeLines: string[] = [];
      const language = fence[1] ?? "";
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/u.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <CodeBlock
          key={`block-${blockKey++}`}
          language={language}
          code={codeLines.join("\n")}
        />,
      );
      continue;
    }

    if (/^\s*\$\$\s*$/u.test(line) || /^\s*\\\[\s*$/u.test(line)) {
      const closing = /^\s*\$\$\s*$/u.test(line)
        ? /^\s*\$\$\s*$/u
        : /^\s*\\\]\s*$/u;
      const mathLines: string[] = [];
      index += 1;
      while (index < lines.length && !closing.test(lines[index] ?? "")) {
        mathLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <MathExpression
          key={`block-${blockKey++}`}
          display
          expression={mathLines.join(" ").trim()}
        />,
      );
      continue;
    }
    const inlineBlockMath = /^\s*\$\$([\s\S]+)\$\$\s*$/u.exec(line);
    if (inlineBlockMath) {
      blocks.push(
        <MathExpression
          key={`block-${blockKey++}`}
          display
          expression={inlineBlockMath[1] ?? ""}
        />,
      );
      index += 1;
      continue;
    }
    const bracketMath = /^\s*\\\[([\s\S]+)\\\]\s*$/u.exec(line);
    if (bracketMath) {
      blocks.push(
        <MathExpression
          key={`block-${blockKey++}`}
          display
          expression={bracketMath[1] ?? ""}
        />,
      );
      index += 1;
      continue;
    }

    if (isHeading(line)) {
      const match = /^\s{0,3}(#{1,6})\s+(.*)$/u.exec(line);
      const level = match?.[1]?.length ?? 2;
      const Heading = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      blocks.push(
        createElement(
          Heading,
          { key: `block-${blockKey++}` },
          renderInline(match?.[2] ?? "", `heading-${blockKey}`),
        ),
      );
      index += 1;
      continue;
    }

    if (/^\s*(?:\*\s*){3,}$|^\s*(?:-\s*){3,}$|^\s*(?:_\s*){3,}$/u.test(line)) {
      blocks.push(<hr key={`block-${blockKey++}`} />);
      index += 1;
      continue;
    }

    if (/^\s*>/u.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>/u.test(lines[index] ?? "")) {
        quoteLines.push((lines[index] ?? "").replace(/^\s*>\s?/u, ""));
        index += 1;
      }
      blocks.push(
        <blockquote key={`block-${blockKey++}`}>
          {renderInline(quoteLines.join(" "), `quote-${blockKey}`)}
        </blockquote>,
      );
      continue;
    }

    if (isBullet(line) || isNumbered(line)) {
      const numbered = isNumbered(line);
      const items: string[] = [];
      const start = numbered
        ? Number(/^\s*(\d+)/u.exec(line)?.[1] ?? 1)
        : undefined;
      while (
        index < lines.length &&
        (numbered
          ? isNumbered(lines[index] ?? "")
          : isBullet(lines[index] ?? ""))
      ) {
        items.push(
          (lines[index] ?? "").replace(
            numbered ? /^\s*\d+[.)]\s+/u : /^\s*[-*+]\s+/u,
            "",
          ),
        );
        index += 1;
      }
      const List = numbered ? "ol" : "ul";
      blocks.push(
        createElement(
          List,
          {
            key: `block-${blockKey++}`,
            ...(start && start !== 1 ? { start } : {}),
          },
          ...items.map((item, itemIndex) => (
            <li key={`item-${itemIndex}`}>
              {renderInline(item, `list-${blockKey}-${itemIndex}`)}
            </li>
          )),
        ),
      );
      continue;
    }

    if (
      line.includes("|") &&
      index + 1 < lines.length &&
      /^\s*\|?\s*:?-{3,}/u.test(lines[index + 1] ?? "")
    ) {
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        rows.push(splitTableRow(lines[index] ?? ""));
        index += 1;
      }
      blocks.push(
        <div className={styles.tableScroll} key={`block-${blockKey++}`}>
          <table>
            <thead>
              <tr>
                {headers.map((cell, cellIndex) => (
                  <th scope="col" key={`head-${cellIndex}`}>
                    {renderInline(cell, `table-head-${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`row-${rowIndex}`}>
                  {headers.map((_, cellIndex) => (
                    <td key={`cell-${cellIndex}`}>
                      {renderInline(
                        row[cellIndex] ?? "",
                        `table-${rowIndex}-${cellIndex}`,
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index]?.trim() &&
      !isBlockStart(lines, index)
    ) {
      paragraphLines.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push(
      <p key={`block-${blockKey++}`}>
        {renderInline(paragraphLines.join(" "), `paragraph-${blockKey}`)}
      </p>,
    );
  }

  return (
    <div className={`${styles.message}${className ? ` ${className}` : ""}`}>
      {blocks}
    </div>
  );
}
