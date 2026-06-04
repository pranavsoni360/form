'use client';

import { useState, useRef } from 'react';
import { uploadDocument } from '@/lib/api';

interface FileUploadProps {
  token: string;
  documentType: string;
  onUploadComplete: (url: string) => void;
  existingUrl?: string;
  accept?: string;
}

const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export default function FileUpload({
  token,
  documentType,
  onUploadComplete,
  existingUrl,
  accept = '.pdf,.jpg,.jpeg,.png,image/jpeg,image/png,application/pdf'
}: FileUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<string | null>(existingUrl || null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const validateFile = (file: File): string | null => {
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return 'Invalid file type. Only PDF, JPG, and PNG files are accepted.';
    }
    if (file.size > MAX_FILE_SIZE) {
      return 'File size must be less than 10 MB.';
    }
    return null;
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      e.target.value = '';
      return;
    }

    setError('');
    setUploading(true);

    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }

    try {
      const response = await uploadDocument(token, documentType, file);
      onUploadComplete(response.url);
    } catch (err: any) {
      setError(err.message || 'Upload failed');
      setPreview(null);
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (fileInputRef.current) {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInputRef.current.files = dataTransfer.files;
      fileInputRef.current.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  return (
    <div>
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition ${
          uploading ? 'border-blue-400 bg-blue-50' :
          preview ? 'border-green-400 bg-green-50' :
          error ? 'border-red-400 bg-red-50' :
          'border-gray-300 hover:border-blue-400 hover:bg-blue-50'
        }`}
      >
        {uploading ? (
          <div className="space-y-2">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 mx-auto"></div>
            <p className="text-sm text-blue-600">Uploading...</p>
          </div>
        ) : preview ? (
          <div className="space-y-2">
            {preview.startsWith('data:image') && (
              <img src={preview} alt="Preview" className="max-h-40 mx-auto rounded" />
            )}
            <p className="text-sm text-green-600 flex items-center justify-center gap-1">
              ✓ File uploaded successfully
            </p>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setPreview(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              className="text-xs text-gray-600 hover:text-gray-800 underline"
            >
              Replace file
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 mx-auto"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
            <p className="text-sm text-gray-600">
              <span className="font-medium text-blue-600">Click to upload</span> or drag and drop
            </p>
            <p className="text-xs text-gray-500 font-medium">
              PDF, JPG or PNG only · Max 10 MB
            </p>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        onChange={handleFileSelect}
        accept={accept}
        className="hidden"
      />

      {error && (
        <p className="text-sm text-red-600 mt-2 flex items-center gap-1">
          <span>⚠</span> {error}
        </p>
      )}
    </div>
  );
}
