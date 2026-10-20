package testcase

// Exit is the panic by which a command's run ends with an exit code: its value
// is the code. A run that is deferred CatchExit turns it into the code it returns.
type Exit int

// CatchExit is deferred by a command's run function, with a pointer to its named
// result code: it turns an Exit panic into the code, and re-panics any other value.
func CatchExit(code *int) {
	if recovered := recover(); recovered != nil {
		value, ok := recovered.(Exit)
		if !ok {
			panic(recovered)
		}
		*code = int(value)
	}
}
