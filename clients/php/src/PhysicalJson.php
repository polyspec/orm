<?php
declare(strict_types=1);
namespace Orm;

/** @internal Bounded preflight; never let a general decoder discard duplicates. */
final class PhysicalJson
{
    private int $pos=0;
    private int $nodes=0;
    private array $strings=[];
    private array $objects=[];
    private function __construct(private readonly string $text){}
    private static function fail():never{throw new PhysicalGraphError('');}
    private function peek():string{return $this->text[$this->pos]??'';}
    private function take(string $c):bool{if($this->peek()!==$c)return false;$this->pos++;return true;}
    private function space():void{while($this->pos<strlen($this->text)&&str_contains(" \r\n\t",$this->peek()))$this->pos++;}
    private function string():string
    {
        $start=$this->pos;if(!$this->take('"'))self::fail();
        while($this->pos<strlen($this->text)){
            $c=$this->text[$this->pos++];if($c==='"'){try{$value=json_decode(substr($this->text,$start,$this->pos-$start),false,16,JSON_THROW_ON_ERROR);}catch(\JsonException){self::fail();}
                // Reuse short scalar/key strings without retaining an unbounded cache.
                if(strlen($value)<=64){if(isset($this->strings[$value]))return $this->strings[$value];if(count($this->strings)===256)unset($this->strings[array_key_first($this->strings)]);$this->strings[$value]=$value;}return $value;}
            if(ord($c)<32)self::fail();if($c==='\\'){if($this->pos===strlen($this->text))self::fail();$this->pos++;}
        }
        self::fail();
    }
    private static function number(string $token):bool
    {
        if(strlen($token)>64||preg_match('/\A-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?\z/',$token)!==1)return false;
        $parts=explode('e',strtolower(ltrim($token,'-')));$mantissa=explode('.',$parts[0]);$fraction=$mantissa[1]??'';$digits=ltrim($mantissa[0].$fraction,'0');if($digits==='')return true;
        $exponent=$parts[1]??'0';if(strlen(ltrim($exponent,'+-0'))>2)return false;$shift=(int)$exponent-strlen($fraction);if(abs($shift)>64)return false;
        if($shift<0){$remove=-$shift;if($remove>strlen($digits)||trim(substr($digits,-$remove),'0')!=='')return false;$digits=substr($digits,0,strlen($digits)-$remove);}else{if(strlen($digits)+$shift>16)return false;$digits.=str_repeat('0',$shift);}
        return strlen($digits)<16||(strlen($digits)===16&&strcmp($digits,'9007199254740991')<=0);
    }
    /** Identical small scalar objects share PHP copy-on-write storage. */
    private function object(array $value):array
    {
        if(count($value)>4)return $value;
        foreach($value as$key=>$entry)if(strlen((string)$key)>64||is_array($entry)||is_object($entry)||(is_string($entry)&&strlen($entry)>64))return $value;
        $key=json_encode($value,JSON_THROW_ON_ERROR);if(isset($this->objects[$key]))return $this->objects[$key];if(count($this->objects)===256)unset($this->objects[array_key_first($this->objects)]);$this->objects[$key]=$value;return $value;
    }
    private function value(int $depth):mixed
    {
        $this->space();if(++$this->nodes>3000000)self::fail();$c=$this->peek();
        if($c==='{'||$c==='['){
            if($depth>=16)self::fail();$this->pos++;$object=$c==='{';$close=$object?'}':']';$keys=[];$result=[];$numeric=false;$this->space();if($this->take($close))return $object?new \stdClass():[];
            while(true){if($object){$this->space();$key=$this->string();if(isset($keys[$key]))self::fail();$keys[$key]=true;$this->space();if(!$this->take(':'))self::fail();$result[$key]=$this->value($depth+1);$numeric=$numeric||is_int(array_key_last($result));}else $result[]=$this->value($depth+1);$this->space();if($this->take($close))return $numeric?(object)$result:($object?$this->object($result):$result);if(!$this->take(','))self::fail();}
        }
        if($c==='"')return $this->string();
        foreach(['true'=>true,'false'=>false,'null'=>null]as$literal=>$value)if($this->pos<strlen($this->text)&&substr_compare($this->text,$literal,$this->pos,strlen($literal))===0){$this->pos+=strlen($literal);return $value;}
        if($c==='-'||($c!==''&&$c>='0'&&$c<='9')){$start=$this->pos;while($this->pos<strlen($this->text)&&!str_contains(" \r\n\t,]}",$this->peek()))$this->pos++;$token=substr($this->text,$start,$this->pos-$start);if(self::number($token)){try{return (int)json_decode($token,false,16,JSON_THROW_ON_ERROR);}catch(\JsonException){self::fail();}}}
        self::fail();
    }
    public static function decode(string $text):mixed
    {
        if(strlen($text)>32*1024*1024||preg_match('//u',$text)!==1)self::fail();$scan=new self($text);$value=$scan->value(0);$scan->space();if($scan->pos!==strlen($text))self::fail();return $value;
    }
    public static function encode(array $value):string
    {
        try{$text=json_encode($value,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);}catch(\JsonException){self::fail();}
        if(strlen($text)>32*1024*1024)self::fail();return $text;
    }
}
