import { useState } from "react";

/** Copy `text` to the clipboard with transient "Copied" feedback. Uses the async Clipboard API and
 * falls back to a hidden-textarea + execCommand for insecure/older contexts (e.g. plain-http local
 * runs where navigator.clipboard is unavailable). Styled as a compact ghost chip; pass a className
 * (e.g. "copy-hover") to make it appear only on hover of its container. */
export default function CopyButton({
  text,
  label,
  title = "Copy to clipboard",
  className = "",
}: {
  text: string;
  label?: string;
  title?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* clipboard unavailable — give up silently */
      }
      ta.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <button
      type="button"
      className={"ghost small copy-btn " + className}
      onClick={copy}
      aria-label={title}
      title={title}
    >
      {copied ? "✓ Copied" : "⧉"}
      {label ? " " + label : ""}
    </button>
  );
}
