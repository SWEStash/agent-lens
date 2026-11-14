import { Link } from "react-router";
import { sessionLabel } from "./format";

/** A link to a session's transcript, labelled with its title or short id. */
export const SessionLink = ({ s }: { s: { id: string; title: string | null } }) => (
  <Link to={`/session/${s.id}`}>{sessionLabel(s.title, s.id)}</Link>
);
