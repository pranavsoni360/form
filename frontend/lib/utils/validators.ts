// lib/utils/validators.ts — format validators + browser helpers

export function validatePANFormat(pan: string): boolean {
  return /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan);
}

export function validateAadhaarFormat(aadhaar: string): boolean {
  return /^\d{12}$/.test(aadhaar);
}

export function isValidPhone(phone: string): boolean {
  const cleaned = phone.replace(/\D/g, "");
  return /^[6-9]\d{9}$/.test(cleaned);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidPincode(pincode: string): boolean {
  return /^\d{6}$/.test(pincode);
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

export function isPDFFile(file: File): boolean {
  return file.type === "application/pdf";
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function downloadFile(url: string, filename: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function isOnline(): boolean {
  return typeof navigator !== "undefined" ? navigator.onLine : true;
}

export function isMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  );
}
