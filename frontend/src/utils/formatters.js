/**
 * Format a number with comma separators.
 * @param {number} num - The number to format.
 * @returns {string} The formatted number string.
 */
export function formatNumber(num) {
  if (num == null || isNaN(num)) return '0';
  return Number(num).toLocaleString('en-US');
}

/**
 * Format a date nicely (e.g., "Jan 15, 2026").
 * @param {Date|string|number} date - The date to format.
 * @returns {string} The formatted date string.
 */
export function formatDate(date) {
  if (!date) return 'N/A';
  const d = new Date(date);
  if (isNaN(d.getTime())) return 'Invalid date';
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Format a date with time (e.g., "Jan 15, 2026, 3:45 PM").
 * @param {Date|string|number} date - The date to format.
 * @returns {string} The formatted date and time string.
 */
export function formatDateTime(date) {
  if (!date) return 'N/A';
  const d = new Date(date);
  if (isNaN(d.getTime())) return 'Invalid date';
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }) + ', ' + d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Format a date as a relative time string (e.g., "2 hours ago", "3 days ago").
 * @param {Date|string|number} date - The date to format.
 * @returns {string} The relative time string.
 */
export function formatRelativeTime(date) {
  if (!date) return 'N/A';
  const d = new Date(date);
  if (isNaN(d.getTime())) return 'Invalid date';

  const now = new Date();
  const diffMs = now - d;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  const diffWeek = Math.floor(diffDay / 7);
  const diffMonth = Math.floor(diffDay / 30);
  const diffYear = Math.floor(diffDay / 365);

  if (diffSec < 60) return diffSec <= 0 ? 'Just now' : `${diffSec} second${diffSec !== 1 ? 's' : ''} ago`;
  if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;
  if (diffHr < 24) return `${diffHr} hour${diffHr !== 1 ? 's' : ''} ago`;
  if (diffDay < 7) return `${diffDay} day${diffDay !== 1 ? 's' : ''} ago`;
  if (diffWeek < 5) return `${diffWeek} week${diffWeek !== 1 ? 's' : ''} ago`;
  if (diffMonth < 12) return `${diffMonth} month${diffMonth !== 1 ? 's' : ''} ago`;
  return `${diffYear} year${diffYear !== 1 ? 's' : ''} ago`;
}

/**
 * Convert bytes to a human-readable string (e.g., "1.5 MB").
 * @param {number} bytes - The number of bytes.
 * @param {number} decimals - Number of decimal places (default: 2).
 * @returns {string} The formatted size string.
 */
export function formatBytes(bytes, decimals = 2) {
  if (bytes == null || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  const clampedI = Math.min(i, sizes.length - 1);
  const value = (bytes / Math.pow(k, clampedI)).toFixed(decimals);
  return `${value} ${sizes[clampedI]}`;
}

/**
 * Format a value as a percentage.
 * @param {number} value - The value to format (0-1 range or raw number).
 * @param {number} decimals - Number of decimal places (default: 1).
 * @param {boolean} [isDecimal=false] - Whether the value is already in 0-1 decimal form.
 * @returns {string} The formatted percentage string.
 */
export function formatPercentage(value, decimals = 1, isDecimal = false) {
  if (value == null || isNaN(value)) return '0%';
  const num = isDecimal ? value * 100 : value;
  return `${Number(num).toFixed(decimals)}%`;
}

/**
 * Return Tailwind color classes for a given status string.
 * @param {string} status - The status value (e.g., 'active', 'error', 'pending').
 * @returns {{ bg: string, text: string, dot: string }} Tailwind class names for background, text, and dot indicator.
 */
export function statusColor(status) {
  const s = String(status).toLowerCase();
  switch (s) {
    case 'active':
    case 'online':
    case 'running':
    case 'success':
    case 'completed':
      return { bg: 'bg-emerald-500/15', text: 'text-emerald-400', dot: 'bg-emerald-400' };
    case 'inactive':
    case 'offline':
    case 'stopped':
      return { bg: 'bg-gray-500/15', text: 'text-gray-400', dot: 'bg-gray-400' };
    case 'pending':
    case 'waiting':
    case 'queued':
    case 'starting':
      return { bg: 'bg-amber-500/15', text: 'text-amber-400', dot: 'bg-amber-400' };
    case 'error':
    case 'failed':
    case 'crashed':
      return { bg: 'bg-red-500/15', text: 'text-red-400', dot: 'bg-red-400' };
    case 'paused':
    case 'suspended':
      return { bg: 'bg-orange-500/15', text: 'text-orange-400', dot: 'bg-orange-400' };
    default:
      return { bg: 'bg-blue-500/15', text: 'text-blue-400', dot: 'bg-blue-400' };
  }
}

/**
 * Truncate a string to a maximum length, appending an ellipsis if truncated.
 * @param {string} str - The string to truncate.
 * @param {number} max - The maximum length.
 * @returns {string} The truncated string.
 */
export function truncate(str, max = 50) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

/**
 * Extract a human-readable error message from an API error response.
 * @param {Error|Object|string} error - The error object from a failed API call.
 * @returns {string} The extracted error message.
 */
export function parseApiError(error) {
  if (!error) return 'An unexpected error occurred.';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;

  // Axios-style error with response
  if (error.response) {
    const data = error.response.data;
    if (typeof data === 'string') return data;
    if (data?.message) return data.message;
    if (data?.error) return typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    if (data?.errors && Array.isArray(data.errors)) return data.errors.join(', ');
    return `Server error (${error.response.status})`;
  }

  // Fetch-style error
  if (error.message) return error.message;

  return 'An unexpected error occurred.';
}

/**
 * Return a { color, label } object for a given status, suitable for badge rendering.
 * @param {string} status - The status value.
 * @returns {{ color: string, label: string }} Badge color class and display label.
 */
export function getStatusBadge(status) {
  const s = String(status).toLowerCase();
  switch (s) {
    case 'active':
    case 'online':
      return { color: 'emerald', label: 'Active' };
    case 'inactive':
    case 'offline':
      return { color: 'gray', label: 'Inactive' };
    case 'pending':
    case 'waiting':
    case 'queued':
      return { color: 'amber', label: 'Pending' };
    case 'running':
    case 'starting':
      return { color: 'blue', label: 'Running' };
    case 'completed':
    case 'success':
      return { color: 'green', label: 'Completed' };
    case 'error':
    case 'failed':
    case 'crashed':
      return { color: 'red', label: 'Error' };
    case 'paused':
    case 'suspended':
      return { color: 'orange', label: 'Paused' };
    case 'stopped':
      return { color: 'slate', label: 'Stopped' };
    default:
      return { color: 'indigo', label: status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown' };
  }
}

/**
 * Trigger a browser download of the given content as a file.
 * @param {string|Blob} content - The file content (string or Blob).
 * @param {string} filename - The name for the downloaded file.
 * @param {string} [mimeType='text/plain'] - The MIME type of the file.
 */
export function exportToFile(content, filename, mimeType = 'text/plain') {
  let blob;
  if (content instanceof Blob) {
    blob = content;
  } else {
    blob = new Blob([content], { type: mimeType });
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
