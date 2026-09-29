// HTML de las descripciones de programas (editor del panel): solo formato básico. El editor lo pone con innerHTML y
// un <img onerror=…> o <script> guardado se ejecutaría para todo el equipo que abra el programa.
import sanitizeHtml from "sanitize-html";

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ["p", "br", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "a", "h2", "h3", "h4", "blockquote", "span", "div"],
  allowedAttributes: { a: ["href", "target", "rel"] },
  allowedSchemes: ["https", "http", "mailto", "tel"],
  allowProtocolRelative: false,
  transformTags: {
    // Enlaces externos sin acceso a window.opener.
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, ...(attribs.target === "_blank" ? { rel: "noopener noreferrer" } : {}) } }),
  },
};

export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html ?? "", OPTIONS);
}
