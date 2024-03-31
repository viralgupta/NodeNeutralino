Use Neutralinojs Apps from backend in nodejs

Steps to use:

```bash
npm i node-neutralino
```

backend/index.js
```javascript
const NeutralinoApp = require("node-neutralino")

const app = new NeutralinoApp({url: "/", windowOptions: {enableInspector: false}})

app.init()

app.on("backend.maximize", ()=>{
    app.window.maximize()
})
```

To see the project in working, you can also get started with premade template
```bash
neu create testapp --template viralgupta/node-neutralinojs-template
```

```bash
cd testapp
node backend/index.js
```
