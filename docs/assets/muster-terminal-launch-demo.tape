Output docs/assets/muster-terminal-launch-demo.mp4
Output docs/assets/muster-terminal-launch-demo.gif

Require node
Require ffmpeg

Set Shell "bash"
Set FontSize 17
Set Width 1280
Set Height 720
Set Padding 18
Set WindowBar Rings
Set TypingSpeed 22ms
Set Framerate 24
Set PlaybackSpeed 0.75

Hide
Type "source scripts/muster-launch-demo-env.sh"
Enter
Type "clear"
Enter
Show

Type "muster init"
Enter
Sleep 3.2s

Type "muster onboard --preview --color=always --step purpose"
Enter
Sleep 5s

Type "muster onboard --preview --color=always --step channels"
Enter
Sleep 5s

Ctrl+L
Sleep 700ms

Type "muster channels setup slack --bot-token-env SLACK_BOT_TOKEN --app-token-env SLACK_APP_TOKEN"
Enter
Sleep 3.4s

Type "muster channels setup telegram --bot-token-env TELEGRAM_BOT_TOKEN --public-url https://agent.example.com"
Enter
Sleep 3.2s

Type "muster channels setup gchat --verification-token-env GOOGLE_CHAT_SIGNING_SECRET --public-url https://agent.example.com"
Enter
Sleep 3.2s

Type "muster mcp install git"
Enter
Sleep 2s

Type "muster mcp install browser"
Enter
Sleep 2s

Type "muster integrations status"
Enter
Sleep 5s

Ctrl+L
Sleep 700ms

Type "ssh Frappe-2 'cd /home/goblin/personal && muster tokens --limit 8'"
Enter
Sleep 6s
