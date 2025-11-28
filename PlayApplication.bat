@echo off
TITLE Meu Dia a Dia - Gerenciador de Servidores

echo ===================================================
echo = Iniciando Servidores da Aplicacao "Meu Dia a Dia" =
echo ===================================================
echo.
echo Assumindo que este script esta na pasta raiz do projeto...
echo.

REM --- Inicia o servidor backend (API + DB) em uma nova janela ---
echo [1/3] Iniciando o servidor backend (API)...
cd server
START "Backend Server" npm run dev
cd ..

REM --- Inicia o servidor frontend (Vite Preview) em outra nova janela ---
echo [2/3] Iniciando o servidor de visualizacao do frontend...
cd /d "%~dp0"
npx serve -s -l 3000

REM --- Aguarda um momento para os servidores subirem ---
echo      Aguardando 5 segundos para os servidores iniciarem...
timeout /t 5 > nul

REM --- Abre a aplicacao no navegador ---
echo [3/3] Abrindo a aplicacao no seu navegador...
start http://localhost:3000

echo.
echo =============================================================
echo = Processo finalizado!                                    =
echo = Deixe as duas janelas pretas (servidores) abertas       =
echo = para que a aplicacao continue funcionando.              =
echo =============================================================
echo.
pause