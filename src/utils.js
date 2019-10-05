import crypto from 'crypto';
import md5 from 'md5';

export function MD5(string) {
  /* istanbul ignore if */
  if (process.browser) {
    return md5(string);
  }
  return crypto.createHash('md5').update(string).digest('hex');
};
