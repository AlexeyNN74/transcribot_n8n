'use strict';
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.beget.com',
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: true,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
});

async function sendEmail(to, subject, html) {
  try {
    await transporter.sendMail({
      from: `"Студия Транскрибации" <${process.env.SMTP_FROM}>`,
      to, subject, html
    });
  } catch (e) {
    console.error('Email error:', e.message);
  }
}

module.exports = { sendEmail };
