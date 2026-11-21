/** The page `/app/` shows while no bridge is connected. No script, no outside request. */
export const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Mac offline</title>
<style>
body{font:16px system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:var(--tg-theme-bg-color,#fff);color:var(--tg-theme-text-color,#111)}
main{text-align:center;padding:2rem}
h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:0;opacity:.7}
</style>
</head>
<body>
<main>
<h1>Your Mac is offline</h1>
<p>Nothing can be shown until it is awake and connected. This page tries again by itself.</p>
</main>
</body>
</html>
`

export const OFFLINE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors https://web.telegram.org https://webk.telegram.org https://webz.telegram.org"
