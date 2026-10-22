import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * A write-only key in the selected environment's secret store. A saved key
 * arrives as a redaction marker, so the field only says whether one is set.
 */
export function SecretKeyField({
  label,
  saved,
  onSave,
}: {
  readonly label: string;
  readonly saved: boolean;
  readonly onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim() === "") return;
        onSave(draft.trim());
        setDraft("");
      }}
    >
      <Input
        type="password"
        autoComplete="off"
        size="sm"
        aria-label={label}
        placeholder={saved ? `${label} saved, enter a new one to replace it` : label}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      {saved ? (
        <Button size="xs" variant="outline" onClick={() => onSave("")}>
          Remove
        </Button>
      ) : null}
      <Button type="submit" size="xs" disabled={draft.trim() === ""}>
        Save
      </Button>
    </form>
  );
}
