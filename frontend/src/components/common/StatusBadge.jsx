import React from 'react';

/**
 * StatusBadge - Color-coded status indicator with optional pulse animation.
 *
 * @param {Object} props
 * @param {string} props.status
 *   The status string to display (e.g. 'active', 'error', 'running').
 * @param {string} [props.size='md']
 *   Badge size: 'sm' | 'md' | 'lg'.
 *
 * Status-to-color mapping:
 *   active, online, completed, success -> green
 *   inactive, offline, pending, uploaded -> gray
 *   running, processing -> blue (with pulse)
 *   error, failed, banned, revoked, expired -> red
 *   warning, paused -> yellow
 *   default -> gray
 */
export default function StatusBadge({ status, size = 'md' }) {
  const normalizedStatus = status.toLowerCase().trim();

  /** Map status keyword to a color group */
  const getColorGroup = () => {
    switch (normalizedStatus) {
      case 'active':
      case 'online':
      case 'completed':
      case 'success':
        return 'green';
      case 'inactive':
      case 'offline':
      case 'pending':
      case 'uploaded':
        return 'gray';
      case 'running':
      case 'processing':
        return 'blue';
      case 'error':
      case 'failed':
      case 'banned':
      case 'revoked':
      case 'expired':
        return 'red';
      case 'warning':
      case 'paused':
        return 'yellow';
      default:
        return 'gray';
    }
  };

  const colorGroup = getColorGroup();

  /** Background color for the badge pill */
  const bgStyles = {
    green: 'bg-green-500/15 text-green-400 border-green-500/30',
    gray: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
    blue: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    red: 'bg-red-500/15 text-red-400 border-red-500/30',
    yellow: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  };

  /** Dot color for the indicator */
  const dotStyles = {
    green: 'bg-green-400',
    gray: 'bg-gray-400',
    blue: 'bg-blue-400',
    red: 'bg-red-400',
    yellow: 'bg-yellow-400',
  };

  /** Size configurations: text size, padding, dot size */
  const sizeStyles = {
    sm: { text: 'text-xs', padding: 'px-2 py-0.5', dot: 'w-1.5 h-1.5' },
    md: { text: 'text-sm', padding: 'px-2.5 py-1', dot: 'w-2 h-2' },
    lg: { text: 'text-base', padding: 'px-3 py-1.5', dot: 'w-2.5 h-2.5' },
  };

  const sizes = sizeStyles[size] || sizeStyles.md;
  const isAnimated = colorGroup === 'blue';

  const label = normalizedStatus.charAt(0).toUpperCase() + normalizedStatus.slice(1);

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-medium ${bgStyles[colorGroup]} ${sizes.padding} ${sizes.text}`}
      role="status"
      aria-label={`Status: ${label}`}
    >
      <span
        className={`inline-block rounded-full ${dotStyles[colorGroup]} ${sizes.dot} ${
          isAnimated ? 'animate-pulse' : ''
        }`}
      />
      {label}
    </span>
  );
}
