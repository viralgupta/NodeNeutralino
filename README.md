Use Neutralinojs Apps from backend in nodejs

Steps to use:

```bash
npm i node-neutralino
```

```javascript
const NeutralinoApp = require("node-neutralino")

const app = new NeutralinoApp({url: "/", windowOptions: {enableInspector: false}})

app.init()

app.on("backend.maximize", ()=>{
    app.window.maximize()
})
```
