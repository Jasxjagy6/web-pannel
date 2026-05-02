/**
 * Coerce any axios error / API error response into a human-readable string
 * suitable for rendering in the UI. The backend wraps errors in
 *   { success: false, error: { message, code, stack? } }
 * but legacy endpoints sometimes return plain strings or `{ message: '...' }`,
 * and uncaught client-side throws produce arbitrary `Error` objects. We
 * normalize all of those here so callers never end up putting a non-string
 * value into React (which would throw "Objects are not valid as a React child").
 */
export function apiError(err, fallback = 'Unknown error') {
  if (!err) return fallback;

  // Try the conventional axios shape first.
  const data = err?.response?.data;
  if (data) {
    if (typeof data === 'string') return data;
    const e = data.error;
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object') {
      if (typeof e.message === 'string') return e.message;
      if (typeof e.code === 'string') return e.code;
    }
    if (typeof data.message === 'string') return data.message;
    if (typeof data.error_description === 'string') return data.error_description;
  }

  if (typeof err === 'string') return err;
  if (typeof err.message === 'string') return err.message;
  try {
    return JSON.stringify(err);
  } catch (_) {
    return fallback;
  }
}

export default apiError;
