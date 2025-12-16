## tools

- pre-install npm
- npm i -g
    - so pnpm works
- prompt about major missing pieces (specifically in node binding)
- get cc working
- get npm working
- get nextjs working
- split out node sandbox in to its own package
- clean up polyfills
- misc tools
    - curl
    - grep
    - sed
    - etc

## compiled tools

- git

## experimentation

- x86 -> v86
- llm directory of compiled tools

## security

- isolate all bridged code in to single location for sensitive code
- determine network properties
- determine resource exhausting edge cases (ie allocating resources on the host)
    - set timeout
    - network requests
- plan out security model (compare to cf workers)

