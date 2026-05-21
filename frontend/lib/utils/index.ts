// lib/utils/index.ts — barrel re-export so `import { cn } from '@/lib/utils'`
// continues to work for every shadcn primitive + ops page (26+ files).
//
// New code should prefer the explicit modular imports:
//   import { cn } from '@/lib/utils/cn';
//   import { formatCurrency } from '@/lib/utils/formatters';
//   import { isValidPhone } from '@/lib/utils/validators';
//   import { STATUS_LABELS } from '@/lib/utils/statusConfig';
//   import { ROLES } from '@/lib/utils/constants';

export { cn } from "./cn";

export {
  formatCurrency,
  formatINR,
  formatIndianNumber,
  formatDate,
  formatDateTime,
  formatDateReadable,
  formatDateISO,
  formatPhone,
  formatFileSize,
  maskPAN,
  maskAadhaar,
  getRelativeTime,
  truncate,
  calculateAge,
  generateId,
  sleep,
  debounce,
} from "./formatters";

export {
  validatePANFormat,
  validateAadhaarFormat,
  isValidPhone,
  isValidEmail,
  isValidPincode,
  isImageFile,
  isPDFFile,
  copyToClipboard,
  downloadFile,
  isOnline,
  isMobile,
} from "./validators";

export {
  ROLES,
  TOKEN_KEYS,
  SESSION_KEYS,
  INACTIVITY_WARNING_MS,
  INACTIVITY_LOGOUT_MS,
  AUTOSAVE_DEBOUNCE_MS,
  OTP_MAX_ATTEMPTS,
  OTP_BLOCK_MINUTES,
  CLOUDFRONT_URL,
} from "./constants";

export {
  STATUS_LABELS,
  STATUS_COLORS,
  SUGGESTION_COLORS,
  getStatusLabel,
  getStatusColor,
  getSuggestionColor,
  type ApplicationStatus,
  type AISuggestion,
} from "./statusConfig";
