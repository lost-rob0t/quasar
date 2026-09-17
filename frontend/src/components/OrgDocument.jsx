import { Fragment } from "react";
import ExecutableCodeBlock from "./ExecutableCodeBlock";

function safeHref(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (/^(https?:|mailto:|\/|#)/i.test(value)) return value;
  return null;
}

function inlineParts(text, keyPrefix) {
  const pattern = /(\[\[([^\]]+)\](?:\[([^\]]+)\])?\]|`([^`]+)`|=([^=]+)=|~([^~]+)~)/g;
  const parts = [];
  let cursor = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    if (match[2]) {
      const href = safeHref(match[2]);
      const label = match[3] || match[2];
      parts.push(
        href ? (
          <a key={`${keyPrefix}-${match.index}`} href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
            {label}
          </a>
        ) : (
          <code key={`${keyPrefix}-${match.index}`}>{label}</code>
        )
      );
    } else {
      parts.push(<code key={`${keyPrefix}-${match.index}`}>{match[4] || match[5] || match[6]}</code>);
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function parseDocument(source) {
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  }

  function flushList() {
    if (!list.length) return;
    blocks.push({ type: "list", items: list });
    list = [];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const orgSource = line.match(/^#\+begin_src\s+([^\s]+).*$/i);
    const markdownFence = line.match(/^```([^\s`]*)\s*$/);
    if (orgSource || markdownFence) {
      flushParagraph();
      flushList();
      const language = (orgSource?.[1] || markdownFence?.[1] || "text").trim();
      const endPattern = orgSource ? /^#\+end_src\s*$/i : /^```\s*$/;
      const code = [];
      index += 1;
      while (index < lines.length && !endPattern.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: "code", language, source: code.join("\n") });
      continue;
    }

    const orgHeading = line.match(/^(\*{1,6})\s+(.+)$/);
    const markdownHeading = line.match(/^(#{1,6})\s+(.+)$/);
    if (orgHeading || markdownHeading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "heading",
        level: (orgHeading?.[1] || markdownHeading?.[1]).length,
        text: orgHeading?.[2] || markdownHeading?.[2]
      });
      continue;
    }

    if (/^#\+(title|author|date|options|startup|property):/i.test(line)) continue;

    const item = line.match(/^\s*[-+]\s+(.+)$/);
    if (item) {
      flushParagraph();
      list.push(item[1]);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    if (/^\s*([-_=])\1{2,}\s*$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push({ type: "rule" });
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  return blocks;
}

export default function OrgDocument({ source }) {
  const blocks = parseDocument(source);
  return (
    <article className="org-document">
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        if (block.type === "heading") {
          const Tag = `h${Math.min(6, Math.max(1, block.level))}`;
          return <Tag key={key}>{inlineParts(block.text, key)}</Tag>;
        }
        if (block.type === "paragraph") return <p key={key}>{inlineParts(block.text, key)}</p>;
        if (block.type === "list") {
          return (
            <ul key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-${itemIndex}`}>{inlineParts(item, `${key}-${itemIndex}`)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "code") {
          return <ExecutableCodeBlock key={key} language={block.language} source={block.source} />;
        }
        if (block.type === "rule") return <hr key={key} />;
        return <Fragment key={key} />;
      })}
    </article>
  );
}
