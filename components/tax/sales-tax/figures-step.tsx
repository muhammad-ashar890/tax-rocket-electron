"use client";

import { Plus, Trash2 } from "lucide-react";

import { StepHeading } from "@/components/tax/wizard-ui";
import { Button } from "@/components/ui/button";
import {
  ADJUSTMENT_FIELDS,
  MAX_EXPORT_ROWS,
  MAX_IMPORT_ROWS,
  type ExportForm,
  type FiguresForm,
  type ImportForm,
} from "@/lib/sales-tax/figures";
import { cn } from "@/lib/utils";

const inputClass =
  "h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-amanah focus:ring-2 focus:ring-amanah/20";

const EMPTY_IMPORT: ImportForm = {
  gdNo: "",
  gdDate: "",
  taxableValue: "",
  salesTaxPaid: "",
  isCapitalGoods: false,
};

const EMPTY_EXPORT: ExportForm = { documentNo: "", documentDate: "", valueExclTax: "" };

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function FiguresStep({
  stepNumber,
  form,
  onChange,
}: {
  stepNumber: number;
  form: FiguresForm;
  onChange: (next: FiguresForm) => void;
}) {
  function setImport(index: number, patch: Partial<ImportForm>) {
    onChange({
      ...form,
      imports: form.imports.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    });
  }
  function setExport(index: number, patch: Partial<ExportForm>) {
    onChange({
      ...form,
      exports: form.exports.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    });
  }

  return (
    <div className="space-y-8">
      <StepHeading
        eyebrow={`Step ${stepNumber}`}
        title="Your other figures"
        description="Your invoice files do not hold everything. Fill in what applies to you; leave the rest blank."
      />

      <Section
        title="Carried over and adjustment amounts"
        description="Amounts in rupees. Blank means zero."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {ADJUSTMENT_FIELDS.map((field) => (
            <label key={field.key} className="block space-y-1.5 text-sm font-medium text-foreground">
              <span>
                <span className="text-muted-foreground">Line {field.sr} · </span>
                {field.label}
              </span>
              <input
                value={form.adjustments[field.key]}
                onChange={(event) =>
                  onChange({
                    ...form,
                    adjustments: { ...form.adjustments, [field.key]: event.target.value },
                  })
                }
                placeholder="0.00"
                inputMode="decimal"
                maxLength={20}
                className={inputClass}
              />
              <span className="block text-xs font-normal text-muted-foreground">{field.hint}</span>
            </label>
          ))}
        </div>
      </Section>

      <Section
        title="Input tax limit (section 8B)"
        description="Is your business excluded from the limit on how much input tax you can adjust against output tax?"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            { value: false, title: "No, the limit applies", hint: "The usual case. Input tax is limited to 90% of output tax." },
            { value: true, title: "Yes, my business is excluded", hint: "Choose this only if you know you are excluded." },
          ].map((option) => (
            <button
              key={String(option.value)}
              type="button"
              onClick={() => onChange({ ...form, excludedFrom8B: option.value })}
              className={cn(
                "rounded-xl border-2 p-3.5 text-left text-sm transition-all duration-150",
                form.excludedFrom8B === option.value
                  ? "border-amanah bg-amanah/5 shadow-sm"
                  : "border-border bg-card hover:border-amanah/35",
              )}
            >
              <span className="block font-medium text-foreground">{option.title}</span>
              <span className="block text-xs text-muted-foreground">{option.hint}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="Fixed assets bought this month"
        description="Type the row numbers of your purchases file that are machinery or other fixed assets, for example 7, 9. Leave blank if there are none."
      >
        <input
          value={form.capitalGoodsRows}
          onChange={(event) => onChange({ ...form, capitalGoodsRows: event.target.value })}
          placeholder="e.g. 7, 9"
          maxLength={200}
          className={inputClass}
          aria-label="Fixed asset rows"
        />
      </Section>

      <Section
        title="Imports"
        description="Goods you imported this month. IRIS loads these from customs; add them here so your estimate includes their sales tax."
      >
        <div className="space-y-3">
          {form.imports.map((row, index) => (
            <div key={index} className="space-y-3 rounded-xl border bg-card p-3.5">
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  value={row.gdNo}
                  onChange={(event) => setImport(index, { gdNo: event.target.value })}
                  placeholder="GD number"
                  maxLength={40}
                  className={inputClass}
                  aria-label={`Import ${index + 1} GD number`}
                />
                <input
                  value={row.gdDate}
                  onChange={(event) => setImport(index, { gdDate: event.target.value })}
                  placeholder="Date (2026-08-14), optional"
                  maxLength={10}
                  className={inputClass}
                  aria-label={`Import ${index + 1} date`}
                />
                <input
                  value={row.taxableValue}
                  onChange={(event) => setImport(index, { taxableValue: event.target.value })}
                  placeholder="Value of goods (Rs)"
                  inputMode="decimal"
                  maxLength={20}
                  className={inputClass}
                  aria-label={`Import ${index + 1} value`}
                />
                <input
                  value={row.salesTaxPaid}
                  onChange={(event) => setImport(index, { salesTaxPaid: event.target.value })}
                  placeholder="Sales tax paid (Rs)"
                  inputMode="decimal"
                  maxLength={20}
                  className={inputClass}
                  aria-label={`Import ${index + 1} sales tax paid`}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={row.isCapitalGoods}
                    onChange={(event) => setImport(index, { isCapitalGoods: event.target.checked })}
                    className="h-4 w-4 accent-[#376952]"
                  />
                  These are fixed assets
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    onChange({ ...form, imports: form.imports.filter((_, i) => i !== index) })
                  }
                  className="gap-1.5 text-xs text-muted-foreground"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </Button>
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={form.imports.length >= MAX_IMPORT_ROWS}
            onClick={() => onChange({ ...form, imports: [...form.imports, { ...EMPTY_IMPORT }] })}
            className="gap-1.5"
          >
            <Plus className="h-4 w-4" />
            Add an import
          </Button>
        </div>
      </Section>

      <Section
        title="Exports"
        description="Goods you exported this month. Exports are zero-rated, so only their value is needed."
      >
        <div className="space-y-3">
          {form.exports.map((row, index) => (
            <div key={index} className="space-y-3 rounded-xl border bg-card p-3.5">
              <div className="grid gap-3 sm:grid-cols-3">
                <input
                  value={row.documentNo}
                  onChange={(event) => setExport(index, { documentNo: event.target.value })}
                  placeholder="Document number"
                  maxLength={40}
                  className={inputClass}
                  aria-label={`Export ${index + 1} document number`}
                />
                <input
                  value={row.documentDate}
                  onChange={(event) => setExport(index, { documentDate: event.target.value })}
                  placeholder="Date (2026-08-14), optional"
                  maxLength={10}
                  className={inputClass}
                  aria-label={`Export ${index + 1} date`}
                />
                <input
                  value={row.valueExclTax}
                  onChange={(event) => setExport(index, { valueExclTax: event.target.value })}
                  placeholder="Value (Rs)"
                  inputMode="decimal"
                  maxLength={20}
                  className={inputClass}
                  aria-label={`Export ${index + 1} value`}
                />
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    onChange({ ...form, exports: form.exports.filter((_, i) => i !== index) })
                  }
                  className="gap-1.5 text-xs text-muted-foreground"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </Button>
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={form.exports.length >= MAX_EXPORT_ROWS}
            onClick={() => onChange({ ...form, exports: [...form.exports, { ...EMPTY_EXPORT }] })}
            className="gap-1.5"
          >
            <Plus className="h-4 w-4" />
            Add an export
          </Button>
        </div>
      </Section>
    </div>
  );
}
