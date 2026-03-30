'use client';

interface OTPVerificationProps {
  phone: string;
  onVerified: () => void;
  onSendOTP: () => Promise<void>;
  onVerifyOTP: (otp: string) => Promise<void>;
}

export default function OTPVerification({ phone, onVerified, onSendOTP, onVerifyOTP }: OTPVerificationProps) {
  return null;
}
