@echo off
chcp 65001 >nul
cd /d %~dp0
if exist gradlew.bat (
  call gradlew.bat :app:assembleDebug
) else (
  where gradle >nul 2>nul
  if errorlevel 1 (
    echo 没有找到 gradlew.bat 或系统 Gradle。
    echo 请用 Android Studio：Build ^> Build Bundle(s) / APK(s) ^> Build APK(s)
    pause
    exit /b 1
  )
  call gradle :app:assembleDebug
)
if errorlevel 1 (
  echo.
  echo 构建失败。请打开 Android Studio 查看 Build 面板的第一条红色错误。
  pause
  exit /b 1
)
echo.
echo APK 已生成：app\build\outputs\apk\debug\app-debug.apk
echo 可以把这个 APK 发给同学安装测试。
pause
