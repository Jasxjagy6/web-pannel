import React from 'react';

/**
 * ProgressBar - Animated progress bar with percentage display.
 *
 * @param {Object} props
 * @param {number} props.progress
 *   Progress value from 0 to 100.
 * @param {string} [props.variant='default']
 *   Color variant: 'default' (blue) | 'success' (green) | 'warning' (yellow) | 'error' (red).
 * @param {string} [props.size='md']
 *   Bar height: 'sm' (h-1) | 'md' (h-2) | 'lg' (h-4).
 * @param {boolean} [props.showLabel=true]
 *   Whether to show the percentage text.
 * @param {string} [props.label]
 *   Optional custom label text displayed above the bar.
 */
export function ProgressBar({
  progress,
  variant = 'default',
  size = 'md',
  showLabel = true,
  label,
}) {
  /** Clamp progress between 0 and 100 */
  const clampedProgress = Math.min(100, Math.max(0, progress));

  /** Height class for the bar */
  const heightStyles = {
    sm: 'h-1',
    md: 'h-2',
    lg: 'h-4',
  };

  /** Color classes for the fill bar */
  const variantStyles = {
    default: 'bg-primary-600',
    success: 'bg-green-500',
    warning: 'bg-yellow-500',
    error: 'bg-red-500',
  };

  const heightClass = heightStyles[size] || heightStyles.md;
  const colorClass = variantStyles[variant] || variantStyles.default;

  return (
    <div className="w-full">
      {(label || showLabel) && (
        <div className="flex items-center justify-between mb-1.5">
          {label && (
            <span className="text-sm text-gray-300 font-medium">{label}</span>
          )}
          {showLabel && (
            <span className="text-sm text-gray-400 font-medium">
              {Math.round(clampedProgress)}%
            </span>
          )}
        </div>
      )}
      <div className={`w-full bg-dark-900 rounded-full overflow-hidden ${heightClass}`}>
        <div
          className={`${heightClass} rounded-full ${colorClass} transition-all duration-500 ease-out`}
          style={{ width: `${clampedProgress}%` }}
          role="progressbar"
          aria-valuenow={clampedProgress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label || `${Math.round(clampedProgress)}% complete`}
        />
      </div>
    </div>
  );
}

/**
 * ProgressBars - Renders multiple progress bars stacked vertically.
 * Useful for showing progress across multiple sessions or tasks.
 *
 * @param {Object} props
 * @param {Array<{ label: string, progress: number, variant?: string }>} props.items
 *   Array of progress bar configurations.
 * @param {string} [props.size='md']
 *   Bar height applied to all bars: 'sm' | 'md' | 'lg'.
 * @param {boolean} [props.showLabels=true]
 *   Whether to show labels on all bars.
 */
export function ProgressBars({ items = [], size = 'md', showLabels = true }) {
  if (items.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 w-full">
      {items.map((item, index) => (
        <ProgressBar
          key={index}
          progress={item.progress}
          variant={item.variant || 'default'}
          size={size}
          label={item.label}
          showLabel={showLabels}
        />
      ))}
    </div>
  );
}
