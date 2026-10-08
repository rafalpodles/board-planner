// Mailbox providers anybody can open an address with: an address there says nothing about whose it is
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "yahoo.co.uk",
  "aol.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "web.de",
  "mail.com", "yandex.ru", "mail.ru", "qq.com", "163.com",
]);
