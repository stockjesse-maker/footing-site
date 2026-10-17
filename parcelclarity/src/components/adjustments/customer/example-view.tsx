import { createElement, type ReactNode } from "react";
import type { BrandExample } from "@/lib/adjustments/queries";
import {
  BADGE_EXPIRED,
  BADGE_UNDER_REVIEW,
  NEUTRAL_TITLE,
  PACKAGES_HEADING,
  expiredNextStep,
  expiredText,
  footerDates,
  footerNotes,
  formatExampleDate,
  noteLabel,
  sharedByLine,
  threePl,
  underReviewText,
} from "@/lib/adjustments/customer-copy";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { buildExampleModel, type ComponentLineModel, type GroupModel } from "./example-model";

/**
 * One adjustment example exactly as a customer reads it. This is the ONE presentational component behind both the customer's page
 * (`/portal/model/adjustments`) and the 3PL's "preview as the customer sees it": what staff approve is what the customer gets.
 *
 * It is a Server Component with no browser APIs, so it renders anywhere. It reads only the fields of the projection the database
 * returns (`brand_adjustment_examples`, or `preview_customer_example` read back through the same projection): the title, the optional
 * note, the payload (declared and corrected package(s), delivery, zone, the charges), and the dates. It never looks anything up, never
 * touches a table, and prints nothing the projection does not carry: no rates, counts, per-shipment, monthly or annual figures.
 *
 * Layout: a stacked description list, no table, so it reads at 360 px. Amounts use tabular numerals; every text run wraps anywhere.
 * Headings: the host page supplies the h1. A customer example is an h2 and its groups are h3; in `staffPreview` mode the example is an
 * h3 and its groups h4 (the host page owns the h1 and the h2), and the markup is otherwise identical. The 3PL's frame (its label, the
 * "not shown to the customer" list) belongs to the caller and is never added here.
 *
 * Three states hide the amounts and say why in one neutral sentence whatever the cause: `under_review`, `expired`, and a `current`
 * example whose payload cannot be written in words. In those states the title, the note and the payload are ignored even if sent.
 */

export type ExampleViewMode = "customer" | "staffPreview";

/** The projection fields an example is rendered from. A `BrandExample` is one; the preview builds the same shape (see `exampleFromPreview`). */
export type ExampleViewExample = Pick<BrandExample, "title" | "note" | "payload" | "pricedOn" | "ratesEffectiveFrom" | "validThrough" | "publishedAt" | "state">;

export interface ExampleViewProps {
  example: ExampleViewExample;
  /** The signed-in customer's 3PL (the tenant name). Empty or missing reads as "your 3PL". */
  tenantName: string | null | undefined;
  /**
   * `customer` (default): the example is an h2 and its groups h3. `staffPreview`: the same markup under the 3PL page's h1 and h2 (example h3,
   * groups h4); nothing is added or removed. For a preview, pass `publishedAt` as the date the example would be shared (today).
   */
  mode?: ExampleViewMode;
  /** Overrides the heading level the mode implies (the example's own heading; its groups are one level down). */
  headingLevel?: 2 | 3;
  /** Unique on the page. Callers pass a position-based value ("example-0"); the default suits a page with one example. */
  idPrefix?: string;
  className?: string;
}

type Level = 2 | 3 | 4;

function Heading({ level, id, className, children }: { level: Level; id?: string; className?: string; children: ReactNode }) {
  return createElement(`h${level}`, { id, className }, children);
}

const AMOUNT = "tabular text-xl font-semibold tracking-tight";

function ChargeLine({ line }: { line: ComponentLineModel }) {
  return (
    <div className="grid gap-x-4 gap-y-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
      <dt className="font-medium">{line.label}</dt>
      <dd className="sm:text-right">
        <span className={AMOUNT}>{line.amount}</span>
        {line.qualifier ? <span className="ml-1.5 text-sm text-muted">{line.qualifier}</span> : null}
      </dd>
      <dd className="text-sm text-muted sm:col-span-2">{line.explanation}</dd>
    </div>
  );
}

function Group({ group, level }: { group: GroupModel; level: Level }) {
  return (
    <div className="space-y-1.5">
      <Heading level={level} className="text-base font-semibold tracking-tight">
        {group.title}
      </Heading>
      <dl className="divide-y divide-line rounded-control border border-line px-4">
        {group.lines.map((line, i) => (
          <ChargeLine key={`line-${i}`} line={line} />
        ))}
        {group.subtotal ? (
          <div className="grid gap-x-4 gap-y-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <dt className="font-medium">{group.subtotal.label}</dt>
            <dd className="sm:text-right">
              <span className={AMOUNT}>{group.subtotal.amount}</span>
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

export function ExampleView({ example, tenantName, mode = "customer", headingLevel, idPrefix = "example", className }: ExampleViewProps) {
  const level: Level = headingLevel ?? (mode === "staffPreview" ? 3 : 2);
  const inner = (level + 1) as Level;
  const t = threePl(tenantName);
  const titleId = `${idPrefix}-title`;
  const shell = (children: ReactNode) => (
    <article aria-labelledby={titleId} className={className}>
      <Card className="space-y-5 [overflow-wrap:anywhere]">{children}</Card>
    </article>
  );

  const model = example.state === "current" && example.payload ? buildExampleModel(example.payload, tenantName) : null;
  const dates = model
    ? footerDates({ tenantName, pricedOn: example.pricedOn, ratesEffectiveFrom: example.ratesEffectiveFrom, sharedOn: example.publishedAt, validThrough: example.validThrough })
    : null;

  if (!model || !dates) {
    // Amounts hidden. Nothing the projection might still carry (a title, a note, a payload) is shown: a neutral heading and one sentence.
    const expired = example.state === "expired";
    const expiredSentence = expired ? expiredText(example.validThrough) : null;
    const shared = formatExampleDate(example.publishedAt);
    return shell(
      <>
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <Heading level={level} id={titleId} className="min-w-0 text-lg font-semibold tracking-tight">
            {NEUTRAL_TITLE}
          </Heading>
          <Badge tone={expired ? "neutral" : "warning"}>{expired ? BADGE_EXPIRED : BADGE_UNDER_REVIEW}</Badge>
        </div>
        <div className="space-y-1.5 text-[15px]">
          {expiredSentence ? (
            <>
              <p>{expiredSentence}</p>
              <p className="text-muted">{expiredNextStep(tenantName)}</p>
            </>
          ) : (
            <p>{underReviewText(tenantName)}</p>
          )}
          {shared ? <p className="text-sm text-muted">{sharedByLine(t.name, shared)}.</p> : null}
        </div>
      </>,
    );
  }

  const title = example.title.trim();
  const note = example.note?.trim() ? example.note.trim() : null;
  return shell(
    <>
      <header className="space-y-1.5">
        <Heading level={level} id={titleId} className="text-lg font-semibold tracking-tight">
          {model.heading}
        </Heading>
        {title && title !== model.heading ? <p className="text-[15px] font-medium">{title}</p> : null}
        <p className="text-sm text-muted">{model.provenance}</p>
        {model.context ? <p className="text-sm text-muted">{model.context}</p> : null}
      </header>
      {model.packages ? (
        <div className="space-y-1.5">
          <Heading level={inner} className="text-base font-semibold tracking-tight">
            {PACKAGES_HEADING}
          </Heading>
          <ul className="space-y-1 text-[15px]">
            {model.packages.map((line, i) => (
              <li key={`package-${i}`}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {model.groups.map((group, i) => (
        <Group key={`group-${i}`} group={group} level={inner} />
      ))}
      {note ? (
        <div className="space-y-1 rounded-control bg-surface px-4 py-3">
          <p className="text-sm font-medium">{noteLabel(tenantName)}</p>
          <p className="whitespace-pre-line text-[15px] [overflow-wrap:anywhere]">{note}</p>
        </div>
      ) : null}
      <footer className={cn("space-y-2 border-t border-line pt-4 text-sm text-muted")}>
        <p>{dates}</p>
        <p>{footerNotes(tenantName, model.hasCaseByCase).join(" ")}</p>
      </footer>
    </>,
  );
}
