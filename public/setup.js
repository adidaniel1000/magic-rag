const command = `powershell -c "irm ${location.origin}/install.ps1 | iex"`;
document.getElementById('command').textContent = command;
document.getElementById('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(command); document.getElementById('copy').textContent = 'Copied'; }
  catch { document.getElementById('message').textContent = 'Select and copy the command above.'; }
});
fetch('release.json').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(release => {
  document.getElementById('message').textContent = `Version ${release.version} · Windows 11 x64 · No administrator access required.`;
}).catch(() => { document.getElementById('message').textContent = 'Release files have not been prepared yet. Configure the hostname and run the release command before sharing this installer.'; });
