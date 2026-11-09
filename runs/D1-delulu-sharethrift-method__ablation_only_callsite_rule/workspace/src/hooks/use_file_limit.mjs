import { message } from '../ui/message.mjs';

export function handleFileLimitChange(input, currentCount, maxCount) {
  if (!input.files) return { accepted: 0 };
  const files = Array.from(input.files);
  const remaining = maxCount - currentCount;
  if (remaining <= 0) {
    input.value = '';
    message.info(`Maximum of ${maxCount} images allowed`);
    return { accepted: 0 };
  }
  if (files.length > remaining) {
    input.files = files.slice(0, remaining);
    message.info(
      `${files.length} image${files.length > 1 ? 's' : ''} selected — only ${remaining} accepted`
    );
    return { accepted: remaining };
  }
  return { accepted: files.length };
}

