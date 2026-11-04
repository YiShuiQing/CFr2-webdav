export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

function safeHref(value: string): string {
  if (
    !value ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)
  ) {
    return '#';
  }
  return escapeHtml(value);
}

export function generateHTML(title: string, items: { name: string; href: string }[]): string {
  const safeTitle = escapeHtml(title);
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${safeTitle}</title>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; margin: 0; padding: 20px; background: #f4f4f4; }
        h1 { color: #333; }
        .file-list { background: white; border-radius: 5px; padding: 20px; box-shadow: 0 2px 5px rgba(0,0,0,.1); }
        .file-item { padding: 10px; border-bottom: 1px solid #eee; }
        .file-item:last-child { border-bottom: none; }
        .file-item a { color: #06c; text-decoration: none; }
        .file-item a:hover { text-decoration: underline; }
      </style>
    </head>
    <body>
      <h1>${safeTitle}</h1>
      <div class="file-list">
        ${items.map((item) => `
          <div class="file-item"><a href="${safeHref(item.href)}">${escapeHtml(item.name)}</a></div>
        `).join('')}
      </div>
    </body>
    </html>
  `;
}

export function generateErrorHTML(title: string, message: string): string {
  const safeTitle = escapeHtml(title);
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'">
      <title>${safeTitle}</title>
    </head>
    <body><h1>${safeTitle}</h1><p>${escapeHtml(message)}</p></body>
    </html>
  `;
}
