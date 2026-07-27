import { useNavigate } from "react-router-dom";
import { datumField, type ChartDatum } from "./recharts-types";

export interface Drilldown {
  /** Navigate to the Sessions list filtered to `param=value`, ignoring an empty value. */
  drillFilter: (param: string, value: string | null | undefined) => void;
  /** A Recharts bar `onClick` handler that reads `field` off the clicked datum and drills on it. */
  drillTo: (param: string, field: string) => (datum: ChartDatum) => void;
}

/** Open the Sessions list (the index route "/") filtered to a slice, reusing the Sessions view's URL
 * filters (`error_type`, `model`, …). `drillFilter` is the imperative form (axis labels), `drillTo`
 * the Recharts click handler; `field` is the datum field to read the value from. */
export function useDrilldown(): Drilldown {
  const navigate = useNavigate();
  const drillFilter = (param: string, value: string | null | undefined) => {
    if (value != null && value !== "") navigate(`/?${param}=${encodeURIComponent(value)}`);
  };
  const drillTo = (param: string, field: string) => (datum: ChartDatum) => drillFilter(param, datumField(datum, field));
  return { drillFilter, drillTo };
}
