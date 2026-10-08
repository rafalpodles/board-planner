// Mailbox providers anybody can open an address with: an address there says nothing about whose it is, so no
// company-wide limit may be applied to it. A provider missing here is treated as one company; add it
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "outlook.pl", "outlook.de", "outlook.fr", "hotmail.com", "hotmail.co.uk", "hotmail.de",
  "hotmail.fr", "live.com", "live.co.uk", "msn.com", "yahoo.com", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "yahoo.pl", "yahoo.es",
  "yahoo.it", "ymail.com", "rocketmail.com", "aol.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com",
  "protonmail.ch", "pm.me", "gmx.com", "gmx.de", "gmx.net", "gmx.at", "gmx.ch", "web.de", "mail.com", "yandex.ru", "yandex.com",
  "mail.ru", "bk.ru", "inbox.ru", "list.ru", "qq.com", "163.com", "126.com", "sina.com", "zoho.com", "fastmail.com", "fastmail.fm",
  "tutanota.com", "tutamail.com", "tuta.io", "tuta.com", "hey.com", "duck.com", "mailbox.org", "posteo.de", "t-online.de", "freenet.de",
  "wp.pl", "o2.pl", "onet.pl", "onet.eu", "op.pl", "interia.pl", "interia.eu", "poczta.fm", "gazeta.pl", "tlen.pl", "vp.pl", "autograf.pl",
  "buziaczek.pl", "go2.pl", "orange.fr", "free.fr", "wanadoo.fr", "laposte.net", "sfr.fr", "libero.it", "virgilio.it", "tiscali.it",
  "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net", "cox.net", "charter.net", "btinternet.com", "sky.com",
  "virginmedia.com", "ntlworld.com", "talktalk.net", "rediffmail.com", "naver.com", "daum.net", "seznam.cz", "centrum.cz", "email.cz",
]);
