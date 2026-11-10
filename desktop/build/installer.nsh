; Chạy trước khi cài / cập nhật: tắt CircleVault đang chạy và backend Python nhúng của nó (resources\python\pythonw.exe
; trong thư mục cài) để không bị khoá file. Không đụng tới Python khác trên máy.
!macro customInit
  nsExec::Exec 'taskkill /f /im "CircleVault.exe"'
  Pop $0
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process pythonw,python,ffmpeg,deno -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '$LOCALAPPDATA\Programs\circlevault\*' } | Stop-Process -Force"`
  Pop $0
!macroend
