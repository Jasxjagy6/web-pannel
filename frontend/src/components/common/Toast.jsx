import { create } from 'zustand';
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  InformationCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';

const TOAST_ICON_MAP = {
  success: CheckCircleIcon,
  error: ExclamationCircleIcon,
  warning: ExclamationCircleIcon,
  info: InformationCircleIcon,
};

const TOAST_COLOR_MAP = {
  success: {
    bg: 'bg-green-900/80 backdrop-blur-sm',
    border: 'border-green-500/50',
    icon: 'text-green-400',
    text: 'text-green-100',
    close: 'text-green-300 hover:bg-green-800/50',
    progress: 'bg-green-500',
  },
  error: {
    bg: 'bg-red-900/80 backdrop-blur-sm',
    border: 'border-red-500/50',
    icon: 'text-red-400',
    text: 'text-red-100',
    close: 'text-red-300 hover:bg-red-800/50',
    progress: 'bg-red-500',
  },
  warning: {
    bg: 'bg-yellow-900/80 backdrop-blur-sm',
    border: 'border-yellow-500/50',
    icon: 'text-yellow-400',
    text: 'text-yellow-100',
    close: 'text-yellow-300 hover:bg-yellow-800/50',
    progress: 'bg-yellow-500',
  },
  info: {
    bg: 'bg-blue-900/80 backdrop-blur-sm',
    border: 'border-blue-500/50',
    icon: 'text-blue-400',
    text: 'text-blue-100',
    close: 'text-blue-300 hover:bg-blue-800/50',
    progress: 'bg-blue-500',
  },
};

const useToastStore = create((set, get) => ({
  toasts: [],
  addToast: (toast) => {
    // Deduplicate: if a toast with same message+type already exists, don't add another
    const existingToasts = get().toasts;
    const isDuplicate = existingToasts.some(
      (t) => t.message === toast.message && t.type === toast.type
    );
    if (isDuplicate) return;

    const id = Date.now();
    set((state) => ({
      toasts: [...state.toasts, { ...toast, id }],
    }));
    setTimeout(() => {
      set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id),
      }));
    }, toast.duration || 3000);
  },
  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },
}));

export function useToast() {
  const addToast = useToastStore((state) => state.addToast);
  const removeToast = useToastStore((state) => state.removeToast);

  return {
    addToast,
    removeToast,
    showSuccess: (message, title) => addToast({ message, title, type: 'success' }),
    showError: (message, title) => addToast({ message, title, type: 'error' }),
    showWarning: (message, title) => addToast({ message, title, type: 'warning' }),
    showInfo: (message, title) => addToast({ message, title, type: 'info' }),
    success: (message, title) => addToast({ message, title, type: 'success' }),
    error: (message, title) => addToast({ message, title, type: 'error' }),
    warning: (message, title) => addToast({ message, title, type: 'warning' }),
    info: (message, title) => addToast({ message, title, type: 'info' }),
  };
}

function ToastItem({ toast, onRemove }) {
  const colors = TOAST_COLOR_MAP[toast.type] || TOAST_COLOR_MAP.info;
  const IconComponent = TOAST_ICON_MAP[toast.type] || InformationCircleIcon;

  return (
    <div
      className={`flex w-full max-w-sm items-start gap-3 rounded-lg border ${colors.border} ${colors.bg} p-4 shadow-lg transition-all duration-300 animate-slide-in`}
      role="alert"
    >
      <IconComponent className={`h-5 w-5 flex-shrink-0 ${colors.icon}`} />
      <div className="flex-1">
        {toast.title && (
          <p className={`text-sm font-semibold ${colors.text}`}>{toast.title}</p>
        )}
        <p className={`text-sm ${colors.text}`}>{toast.message}</p>
      </div>
      <button
        onClick={() => onRemove(toast.id)}
        className={`flex-shrink-0 rounded p-1 transition-colors ${colors.close}`}
        aria-label="Dismiss notification"
      >
        <XMarkIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed right-4 top-4 z-50 flex flex-col gap-3">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
      ))}
    </div>
  );
}
