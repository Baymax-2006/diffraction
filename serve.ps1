# serve.ps1 — 无 Python / Node 时的 Windows 备用静态服务器（PowerShell 自带 HttpListener）
param([int]$Port = 8765)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$mime = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.json'='application/json; charset=utf-8'; '.png'='image/png'; '.md'='text/markdown; charset=utf-8'; '.csv'='text/csv; charset=utf-8' }
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "圆孔衍射实验已启动：http://127.0.0.1:$Port/index.html  （关闭此窗口即停止）"
Start-Process "http://127.0.0.1:$Port/index.html"
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
  if ($rel -eq '') { $rel = 'index.html' }
  $file = [IO.Path]::GetFullPath((Join-Path $root $rel))
  if ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf)) {
    $bytes = [IO.File]::ReadAllBytes($file)
    $ext = [IO.Path]::GetExtension($file).ToLower()
    $ctx.Response.ContentType = $(if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' })
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } else { $ctx.Response.StatusCode = 404 }
  $ctx.Response.Close()
}
