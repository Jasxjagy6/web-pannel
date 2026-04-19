import { useState, useCallback } from 'react';
import {
  CloudArrowUpIcon,
  DocumentIcon,
  XMarkIcon,
  PaperClipIcon,
} from '@heroicons/react/24/outline';

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export default function FileUpload({
  accept = '*',
  multiple = false,
  maxSize = 10 * 1024 * 1024,
  onFilesChange = () => {},
  label = 'Upload files',
  description = 'Drag and drop files here, or click to browse',
  icon = null,
}) {
  const [files, setFiles] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [errors, setErrors] = useState([]);

  const validateFile = useCallback(
    (file) => {
      if (file.size > maxSize) {
        return `${file.name} exceeds the maximum size of ${formatFileSize(maxSize)}`;
      }
      return null;
    },
    [maxSize]
  );

  const processFiles = useCallback(
    (fileList) => {
      const newErrors = [];
      const validFiles = [];

      Array.from(fileList).forEach((file) => {
        const error = validateFile(file);
        if (error) {
          newErrors.push(error);
        } else {
          validFiles.push(file);
        }
      });

      setErrors(newErrors);
      const updatedFiles = multiple ? [...files, ...validFiles] : validFiles;
      setFiles(updatedFiles);
      onFilesChange(updatedFiles);
    },
    [files, multiple, validateFile, onFilesChange]
  );

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        processFiles(e.dataTransfer.files);
      }
    },
    [processFiles]
  );

  const handleInputChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
    }
  };

  const removeFile = (index) => {
    const updatedFiles = files.filter((_, i) => i !== index);
    setFiles(updatedFiles);
    onFilesChange(updatedFiles);
  };

  return (
    <div className="w-full">
      <label className="mb-2 block text-sm font-medium text-gray-700">{label}</label>

      <div
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={`relative flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
          isDragging
            ? 'border-blue-500 bg-blue-50'
            : 'border-gray-300 bg-gray-50 hover:bg-gray-100'
        }`}
      >
        <input
          type="file"
          accept={accept}
          multiple={multiple}
          onChange={handleInputChange}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />

        <div className="pointer-events-none flex flex-col items-center">
          {icon || (
            <CloudArrowUpIcon
              className={`mb-3 h-10 w-10 ${
                isDragging ? 'text-blue-500' : 'text-gray-400'
              }`}
            />
          )}
          <p className="text-sm font-medium text-gray-700">{description}</p>
          <p className="mt-1 text-xs text-gray-500">
            Max size: {formatFileSize(maxSize)}
          </p>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="mt-3 space-y-1">
          {errors.map((error, index) => (
            <p key={index} className="text-xs text-red-600">
              {error}
            </p>
          ))}
        </div>
      )}

      {files.length > 0 && (
        <ul className="mt-3 space-y-2">
          {files.map((file, index) => (
            <li
              key={index}
              className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2"
            >
              <div className="flex items-center gap-2 overflow-hidden">
                <PaperClipIcon className="h-4 w-4 flex-shrink-0 text-gray-400" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-700">
                    {file.name}
                  </p>
                  <p className="text-xs text-gray-500">{formatFileSize(file.size)}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => removeFile(index)}
                className="ml-2 flex-shrink-0 rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                aria-label={`Remove ${file.name}`}
              >
                <XMarkIcon className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
