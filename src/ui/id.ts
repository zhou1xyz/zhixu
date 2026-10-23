/**
 * 主键生成
 *
 * 用浏览器原生的 crypto.randomUUID()，不引第三方库。
 */
export function newId(): string {
  return crypto.randomUUID();
}
