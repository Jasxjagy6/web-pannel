import React, { useEffect, useCallback, useRef } from 'react';
import { X } from 'lucide-react';

/**
 * Modal - Reusable modal dialog with backdrop.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen
 *   Whether the modal is currently visible.
 * @param {Function} props.onClose
 *   Callback to close the modal.
 * @param {string} props.title
 *   Title displayed in the modal header.
 * @param {React.ReactNode} props.children
 *   Modal body content.
 * @param {string} [props.size='md']
 *   Modal width: 'sm' | 'md' | 'lg' | 'xl' | 'fullscreen'.
 * @param {React.ReactNode} [props.footer]
 *   Optional footer content (typically action buttons).
 */
export function Modal({
  isOpen,
  onClose,
  title,
  children,
  size = 'md',
  footer,
}) {
  const overlayRef = useRef(null);
  const modalRef = useRef(null);
  const previousFocusRef = useRef(null);

  /** Width class based on size prop */
  const sizeStyles = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    fullscreen: 'max-w-7xl',
  };

  const widthClass = sizeStyles[size] || sizeStyles.md;

  /** Save current focus, trap focus, restore focus on unmount */
  useEffect(() => {
    if (!isOpen) return;

    /* Store the element that was focused before the modal opened */
    previousFocusRef.current = document.activeElement;

    /* Prevent body scroll while modal is open */
    document.body.style.overflow = 'hidden';

    /* Focus the modal container for accessibility */
    const timer = setTimeout(() => {
      if (modalRef.current) {
        modalRef.current.focus();
      }
    }, 50);

    return () => {
      clearTimeout(timer);
      document.body.style.overflow = '';
      /* Restore focus to the previously focused element */
      if (previousFocusRef.current && previousFocusRef.current.focus) {
        previousFocusRef.current.focus();
      }
    };
  }, [isOpen]);

  /** Handle Escape key to close */
  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    },
    [onClose]
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, handleKeyDown]);

  /** Handle backdrop click - only close if the overlay itself is clicked */
  const handleBackdropClick = useCallback(
    (e) => {
      if (e.target === overlayRef.current) {
        onClose();
      }
    },
    [onClose]
  );

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm transition-opacity" />

      {/* Modal Panel */}
      <div
        ref={modalRef}
        tabIndex={-1}
        className={`relative w-full ${widthClass} bg-dark-800 rounded-xl border border-white/10 shadow-2xl transform transition-all max-h-[90vh] flex flex-col`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 shrink-0">
          <h2
            id="modal-title"
            className="text-lg font-semibold text-white"
          >
            {title}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body - scrollable */}
        <div className="px-6 py-4 overflow-y-auto flex-1">
          {children}
        </div>

        {/* Footer - optional */}
        {footer && (
          <div className="px-6 py-4 border-t border-white/5 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
