// Document specification for the loan application form.
//
// WHY THIS IS A MODULE AND NOT AN INLINE ARRAY
// The list used to live inside the step-5 JSX, which is why nothing could
// validate against it: `required: true` and the red asterisk were decoration,
// and an application could be submitted with no documents at all. Hoisting it
// means the gate, the render and the file-type rules all read one definition.
//
// EVERY DOCUMENT HAS ITS OWN TYPE AND ITS OWN JOURNEY
// A single `accept=".jpg,.jpeg,.png,.pdf"` on every row let a customer attach a
// photo of a bank statement, or a PDF where a passport photograph was needed —
// both accepted silently, both useless downstream. A bank statement in
// particular MUST be a real PDF: Digitap's parser template-matches the issuing
// bank's layout, so a phone snapshot of a statement cannot be analysed at all.

export type DocSource = "digilocker" | "upload";

export interface LoanDocSpec {
  key: string;
  label: string;
  required: boolean;
  /** `accept` attribute — deliberately narrower than "any file". */
  accept: string;
  /** MIME/extension guard applied client-side before the upload fires. */
  extensions: string[];
  /** One line telling the customer what a valid file looks like. */
  hint: string;
  /**
   * Documents DigiLocker can satisfy on the customer's behalf during KYC. The
   * form shows these as already-provided rather than asking twice — which is
   * also why Documents must stay AFTER the KYC step, not before it.
   */
  autoFilledBy?: DocSource;
  /** Only shown for consumer-durable applications. */
  consumerDurableOnly?: boolean;
}

const IMG = [".jpg", ".jpeg", ".png"];
const PDF = [".pdf"];
const BOTH = [...IMG, ...PDF];

export const LOAN_DOCUMENTS: LoanDocSpec[] = [
  {
    key: "aadhaar_front_url",
    label: "Aadhaar Document",
    required: true,
    accept: ".jpg,.jpeg,.png,.pdf",
    extensions: BOTH,
    hint: "The DigiLocker Aadhaar XML, or a clear photo/scan of the card.",
    autoFilledBy: "digilocker",
  },
  {
    key: "photo_url",
    label: "Passport Size Photo",
    required: true,
    // Images ONLY. A PDF here breaks every downstream consumer that renders a
    // face — and customers do attach PDFs when the picker allows it.
    accept: ".jpg,.jpeg,.png",
    extensions: IMG,
    hint: "A recent passport-style photograph. JPG or PNG — not a PDF.",
    autoFilledBy: "digilocker",
  },
  {
    key: "bank_statements_url",
    label: "Bank Statements (Last 6 months)",
    required: true,
    // PDF ONLY, and this one is load-bearing. The statement is the single
    // document that feeds the cash-flow score, and Digitap parses it by matching
    // the issuing bank's PDF template. A photo of a statement yields nothing.
    accept: ".pdf",
    extensions: PDF,
    hint: "The PDF your bank issues — downloaded from net banking or their app. A photo of a statement cannot be read.",
  },
  {
    key: "salary_slips_url",
    // No longer required: Aadhaar and photo are usually DigiLocker-satisfied,
    // and the bank statement is what actually reaches scoring. Kept because it
    // is still the clearest income evidence an officer can read by eye, and
    // because statement analysis does not yet extract salary credits.
    label: "Salary Slips (Last 3 months)",
    required: false,
    accept: ".jpg,.jpeg,.png,.pdf",
    extensions: BOTH,
    hint: "Optional. Helps if your salary is not obvious from the statement.",
  },
  {
    key: "itr_form16_url",
    label: "ITR / Form 16",
    required: false,
    accept: ".pdf",
    extensions: PDF,
    hint: "Optional. The PDF from the income-tax portal or your employer.",
  },
  {
    key: "proof_of_identification_url",
    label: "Proof of Identification",
    required: false,
    accept: ".jpg,.jpeg,.png,.pdf",
    extensions: BOTH,
    hint: "Only if you did not verify with DigiLocker — a verified Aadhaar covers this.",
    autoFilledBy: "digilocker",
  },
  {
    key: "proof_of_residence_url",
    label: "Proof of Residence",
    required: false,
    accept: ".jpg,.jpeg,.png,.pdf",
    extensions: BOTH,
    hint: "Only if you did not verify with DigiLocker — a verified Aadhaar covers this.",
    autoFilledBy: "digilocker",
  },
  {
    key: "quotation_url",
    label: "Dealer Quotation",
    required: true,
    accept: ".jpg,.jpeg,.png,.pdf",
    extensions: BOTH,
    hint: "The quotation from the dealer for the item you are financing.",
    consumerDurableOnly: true,
  },
];

/** The documents that apply to this application. */
export function documentsFor(loanType: string | undefined): LoanDocSpec[] {
  const isCD = (loanType || "personal") === "consumer_durable";
  return LOAN_DOCUMENTS.filter((d) => !d.consumerDurableOnly || isCD);
}

/** Required documents still missing, in display order. */
export function missingRequired(
  loanType: string | undefined,
  formData: Record<string, any>,
): LoanDocSpec[] {
  return documentsFor(loanType).filter((d) => d.required && !formData[d.key]);
}

/**
 * Validate a chosen file against ONE document's rules.
 *
 * Extension is checked rather than MIME type: browsers report inconsistent MIME
 * for PDFs and some Android pickers send `application/octet-stream`, which would
 * reject valid files. Returns an error string, or "" when acceptable.
 */
export function validateDocFile(spec: LoanDocSpec, file: File): string {
  const name = (file.name || "").toLowerCase();
  const ok = spec.extensions.some((e) => name.endsWith(e));
  if (!ok) {
    const pretty = spec.extensions.map((e) => e.replace(".", "").toUpperCase()).join(" or ");
    return `${spec.label} must be a ${pretty} file.`;
  }
  if (file.size > 5 * 1024 * 1024) return "File too large. Max 5MB allowed";
  if (file.size === 0) return "That file is empty. Please choose another.";
  return "";
}
