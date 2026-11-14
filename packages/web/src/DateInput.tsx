import { useResetOn } from "./useResetOn";

/** A date filter bound to a URL param. The router applies location changes as a transition, and a
 * controlled input bound straight to the URL reverts between keystrokes until that transition
 * commits, so typing a year by keyboard loses digits. The field owns its value and the URL follows;
 * a change that comes from the URL (back button, clear filters) resets it. */
export function DateInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [input, setInput] = useResetOn(value, value);
  return (
    <input
      type="date"
      value={input}
      onChange={(e) => {
        setInput(e.target.value);
        onChange(e.target.value);
      }}
    />
  );
}
