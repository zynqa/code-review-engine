<?php

class Zynqa_Sniffs_Files_ForbiddenRuntimeFunctionsSniff implements PHP_CodeSniffer\Sniffs\Sniff
{
    private $forbiddenFunctions = [
        'error_log' => 'Use PSR-3 or Magento logging services instead of error_log().',
        'eval' => 'Do not execute dynamic PHP code with eval().',
        'file_put_contents' => 'Use Magento filesystem abstractions instead of file_put_contents().',
        'ini_set' => 'Do not mutate PHP runtime configuration from module code.',
        'mail' => 'Use Magento mail transport instead of mail().',
        'print_r' => 'Do not leave print_r() debugging calls in committed code.',
        'session_start' => 'Use Magento session services instead of calling session_start().',
        'set_time_limit' => 'Do not change script execution limits from module code.',
        'sleep' => 'Do not block execution with sleep() in production code.',
        'utf8_encode' => 'Avoid utf8_encode(); use framework-safe encoding handling instead.',
        'var_dump' => 'Do not leave var_dump() debugging calls in committed code.',
    ];

    public function register()
    {
        return [T_STRING, T_EXIT, T_VARIABLE];
    }

    public function process(PHP_CodeSniffer\Files\File $phpcsFile, $stackPtr)
    {
        $tokens = $phpcsFile->getTokens();
        $token = $tokens[$stackPtr];

        if ($token['code'] === T_EXIT) {
            $phpcsFile->addError(
                'Do not terminate execution with exit/die in module code.',
                $stackPtr,
                'ExitOrDie'
            );
            return;
        }

        $prevPtr = $phpcsFile->findPrevious(T_WHITESPACE, $stackPtr - 1, null, true);
        if ($prevPtr !== false && $tokens[$prevPtr]['content'] === '@') {
            $phpcsFile->addError(
                'Do not suppress errors with @; handle the failure explicitly.',
                $prevPtr,
                'SilencedError'
            );
        }

        if ($token['code'] === T_VARIABLE) {
            return;
        }

        $functionName = strtolower($token['content']);
        if (!isset($this->forbiddenFunctions[$functionName])) {
            return;
        }

        $prevPtr = $phpcsFile->findPrevious(T_WHITESPACE, $stackPtr - 1, null, true);
        if ($prevPtr !== false && in_array($tokens[$prevPtr]['code'], [T_OBJECT_OPERATOR, T_DOUBLE_COLON, T_FUNCTION], true)) {
            return;
        }

        $nextPtr = $phpcsFile->findNext(T_WHITESPACE, $stackPtr + 1, null, true);
        if ($nextPtr === false || $tokens[$nextPtr]['code'] !== T_OPEN_PARENTHESIS) {
            return;
        }

        $phpcsFile->addError(
            $this->forbiddenFunctions[$functionName],
            $stackPtr,
            'ForbiddenFunction'
        );
    }
}
