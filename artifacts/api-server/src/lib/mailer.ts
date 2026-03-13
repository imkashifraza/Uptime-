import nodemailer from 'nodemailer';

export const GMAIL_USER = 'technicalsolutinon@gmail.com';

export const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: 'lxpawjiawkzmqcde' },
});

export function sendEmail(to: string, subject: string, html: string) {
  mailer.sendMail({ from: GMAIL_USER, to, subject, html }).catch(console.error);
}
