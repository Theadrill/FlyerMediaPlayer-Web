@echo off
cd /d "%~dp0"
echo Verificando e instalando dependencias (incluindo o electron-builder)...
call npm install
echo.
echo Iniciando compilacao do executavel...
call npm run dist
echo.
echo Criando atalho FlyerMediaPlayer.lnk na raiz do projeto...
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%~dp0FlyerMediaPlayer.lnk');$s.TargetPath='%~dp0dist\FlyerMediaPlayer.exe';$s.WorkingDirectory='%~dp0dist';$s.Save()"
echo.
echo Concluido! O executavel estara na pasta "dist" e o atalho foi criado na raiz do projeto.
pause
